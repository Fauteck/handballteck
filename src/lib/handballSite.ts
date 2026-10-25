/**
 * Die Handball-Microsite (Wiki „Handball-Verfolgung (handball.net)“ §7): eine öffentliche
 * Mannschaftsseite im CD des Vereins, ohne Anmeldung, ohne Todoteck-Gewand
 * — zum Weitergeben an Eltern, Spieler und Freunde, die weder ein
 * Todoteck-Konto noch Telegram haben.
 *
 * **Warum eine gerenderte Seite aus der API und kein zweiter Frontend-Build:**
 * Alles, was die Seite zeigt, liegt schon in der Datenbank (Spielplan,
 * Tabelle, Bilder des Bots). Ein eigener React-Build hätte eine zweite
 * Auslieferung gebraucht — hier ist es eine Route, die HTML zurückgibt, wie
 * `/public/display.png` ein Bild zurückgibt. Kein Bundler, keine Abhängigkeit
 * von `apps/web`, kein Todoteck-Stylesheet: Das CSS steht in dieser Datei
 * und nimmt die Vereinsfarben aus derselben Palette wie die Bilder
 * (`themeFor`), die Schrift ist dieselbe Barlow.
 *
 * **Alle Verweise sind relativ** (`./bild/spiel.png`, `./sw.js`, `./feed.xml`).
 * Deshalb kann ein Reverse-Proxy die Seite unter einer eigenen Domain
 * ausliefern (`woelfe.example.de/` → diese Wurzel, `SITE_URL`), ohne dass
 * hier etwas umgeschrieben werden muss — und deshalb endet die Seitenadresse
 * mit einem Schrägstrich (die Route ohne leitet dorthin um). Absolute
 * Adressen braucht nur, was außerhalb des Browsers gelesen wird: der
 * `webcal://`-Link, der Feed und die Open-Graph-Vorschau; die kommen aus
 * `siteBaseUrl`, also aus der Dienste-Zeile oder `PUBLIC_URL`.
 *
 * **Kein Inline-JavaScript.** Die CSP der API erlaubt Skripte nur von `'self'`
 * — das Skript der Seite kommt deshalb als eigene Route (`./app.js`), Stile
 * dürfen inline stehen (`'unsafe-inline'` für `style-src` ist gesetzt).
 *
 * **Spielernamen immer.** Torjäger, Kader, Saisonkarte und Live-Ticker nennen
 * Namen, auch von Jugendspielern — der Verein hat das so entschieden
 * (2026-10-23; vorher ein Schalter `SITE_PLAYERS`). Fotos bleiben an die
 * Freigabe je Mannschaft gebunden. Die Seite trägt `noindex` — sie ist zum
 * Weitergeben gedacht, nicht zum Finden.
 *
 * **Die Bilder werden zwischengespeichert.** Ein PNG kostet ein paar hundert
 * Millisekunden `sharp`; eine öffentliche Route, die bei jedem Aufruf rendert,
 * wäre ein offener Bild-Generator auf Kosten dieses Servers. Der Cache hängt
 * am Stand der Übersicht (`updated_at`) und an einer kurzen Frist.
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { siteEnabled, sitePhotos, siteUrl, publicUrl as configPublicUrl, siteOperator, siteFeedbackMail, clubName } from '../config';
import {
  seitenUebersicht, aktuellesSpiel, vereinsName, logoDataUri, rosterFor, playerGames, playerStats, playerMatchLog, readPalette, changesFor, tendenzReferenz, opponentFormFor,
  HANDBALL_GROUPS, type HandballTeamView, type HandballMatchView, type HandballGroup,
} from './handballTeam';
import { vervollstaendigePalette, renderWeekendSvg, type FullPalette } from './handballTableImage';
import { bildMitKurzweg, zwischengespeichert, standVon, leereBildCache } from './bildCache';
import { bildMarke } from './handballBotImages';
import {
  bildTabelle, bildKader, bildSpiel, bildVerlauf, bildTorjaeger, bildSaison, endstandBild,
  textSaison, alsKlartext, icsKalender, handballBotLink, getHandballBotUsername,
} from './handballBot';
import { paarungMitStand, ausgangWort } from './handballBotTexts';
import type { HandballStandingRow } from './handballNetClient';
import { siteCss, inhaltsHash, SITE_SW_JS, SITE_APP_JS, SITE_THEME_JS } from './handballSiteAssets';
import { hatGruppenbild, portraits } from './clubdesk';

export { SITE_SW_JS, SITE_APP_JS, SITE_THEME_JS };

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

export interface HandballSiteConfig {
  /** Der Schalter „Microsite freigeben" der Dienste-Zeile. */
  enabled: boolean;
  /** Absolute Adresse der Seite mit Schrägstrich am Ende — aus der Dienste-Zeile, sonst der Pfad unter `PUBLIC_URL`. */
  baseUrl: string;
}

/**
 * Die Wurzel, unter der die Seiten liegen: `SITE_URL` (eigene Domain vor dem
 * Proxy), sonst `PUBLIC_URL`. Die Mannschaftsseite ist `<Wurzel>/<Team-ID>/`.
 */
/** Der Name der Startseite — Titel, App-Name und Teilen-Titel. */
export const SITE_TITEL = 'Wölfe live - Handball im Revier';

export function siteRootUrl(): string {
  return siteUrl() ?? configPublicUrl();
}

export function siteDefaultUrl(teamId: string): string {
  return `${siteRootUrl()}/${encodeURIComponent(teamId)}/`;
}

export function siteConfig(teamId: string): HandballSiteConfig {
  return { enabled: siteEnabled(), baseUrl: siteDefaultUrl(teamId) };
}

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------

/** HTML-Escaping — die Namen kommen aus einer fremden Quelle. */
export function h(text: string | number | null | undefined): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const DATUM_LANG = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' });
const DATUM_KURZ = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'Europe/Berlin' });
const DATUM_MIT_JAHR = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' });
const ZEIT = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
const STAND = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
/** Daten weiter als 60 Tage entfernt tragen das Jahr — in der Winterpause wäre „Sa., 12.09." mehrdeutig. */
const JAHR_AB_MS = 60 * 24 * 60 * 60 * 1000;

function datumKurz(d: Date, now: Date): string {
  return Math.abs(d.getTime() - now.getTime()) > JAHR_AB_MS ? DATUM_MIT_JAHR.format(d) : DATUM_KURZ.format(d);
}

/** `2627` → „2026/27". */
export function saisonLabel(seasonId: number | null | undefined): string | null {
  if (!seasonId) return null;
  const s = String(seasonId);
  if (s.length !== 4) return null;
  return `20${s.slice(0, 2)}/${s.slice(2)}`;
}

function gegnerVon(m: HandballMatchView): string {
  return m.is_home ? m.away_name : m.home_name;
}

/** Punkte klassisch als Plus- und Minuspunkte („6:4"): je Niederlage zwei, je Unentschieden einer gegen. */
function punkteText(r: HandballStandingRow): string {
  return `${r.points}:${2 * r.lost + r.drawn}`;
}

/** Der Stand klassisch: Heimmannschaft zuerst, wie auf dem Spielberichtsbogen — null ohne Ergebnis. */
function standHeimGast(m: HandballMatchView): string | null {
  return m.score_home !== null && m.score_away !== null ? `${m.score_home}:${m.score_away}` : null;
}

/** Statuswort auf Deutsch — die Quelle mischt Deutsch und Spanisch. */
function statusWort(m: HandballMatchView): string | null {
  switch (m.status) {
    case 'live': return 'Live';
    case 'scheduled': if (m.is_live) return 'Live'; return m.rated ? 'Gewertet' : null;
    case 'postponed': return 'Verlegt';
    case 'cancelled': return 'Abgesetzt';
    case 'other': return m.rated ? 'Gewertet' : (m.status_name || 'Sonderfall');
    default: return m.rated ? 'Gewertet' : null;
  }
}

function routenLinks(m: HandballMatchView): Array<{ label: string; href: string }> {
  const ziel = m.venue_lat !== null && m.venue_lon !== null
    ? { g: `https://www.google.com/maps/dir/?api=1&destination=${m.venue_lat},${m.venue_lon}`, o: `https://www.openstreetmap.org/?mlat=${m.venue_lat}&mlon=${m.venue_lon}#map=16/${m.venue_lat}/${m.venue_lon}` }
    : m.venue_address
      ? { g: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(m.venue_address)}`, o: `https://www.openstreetmap.org/search?query=${encodeURIComponent(m.venue_address)}` }
      : null;
  if (!ziel) return [];
  return [{ label: 'Google Maps', href: ziel.g }, { label: 'OpenStreetMap', href: ziel.o }];
}

function eigeneZeile(team: HandballTeamView): HandballStandingRow | null {
  return team.standings.flatMap(s => s.rows).find(r => r.teamId === team.team_id) ?? null;
}

function gespielt(team: HandballTeamView): HandballMatchView[] {
  return team.matches.filter(m => (m.status === 'finished' || m.rated) && m.score_home !== null && m.score_away !== null);
}

// ---------------------------------------------------------------------------
// Bilder mit Cache
// ---------------------------------------------------------------------------

/** Die Bilder der Seite — mit und ohne Spielernamen. */
export const SITE_IMAGES = ['spiel', 'endstand', 'tabelle', 'verlauf', 'torjaeger', 'kader', 'saison'] as const;
export type SiteImageArt = typeof SITE_IMAGES[number];

export function istBildArt(art: string): art is SiteImageArt {
  return (SITE_IMAGES as readonly string[]).includes(art);
}

// Die Bilder liegen im gemeinsamen Zwischenspeicher (`bildCache.ts`), gedeckelt nach Bytes.
const LOGO_FRIST_MS = 6 * 60 * 60 * 1000;

/** Nur für Tests. */
export function resetSiteImageCache(): void {
  leereBildCache();
}

async function bildSvg(team: HandballTeamView, art: SiteImageArt, matchId: string | null): Promise<string | null> {
  switch (art) {
    case 'tabelle': {
      const s = team.standings[0];
      return s && s.rows.length > 0 ? bildTabelle(team, s) : null;
    }
    case 'kader': return bildKader(team);
    case 'spiel': return team.next_match && !team.next_match.is_live ? bildSpiel(team.next_match) : null;
    case 'endstand': {
      const m = matchId
        ? team.matches.find(x => x.match_id === matchId && (x.status === 'finished' || x.rated)) ?? null
        : team.last_match;
      if (!m || m.score_home === null || m.score_away === null) return null;
      const bester = playerGames(team.team_id).filter(g => g.matchId === m.match_id).sort((a, b) => b.goals - a.goals)[0];
      return endstandBild(team, m, {
        playerOfMatch: bester && bester.goals > 0 ? `${bester.name} · ${bester.goals} Tor${bester.goals === 1 ? '' : 'e'}` : null,
      });
    }
    case 'verlauf': return bildVerlauf(team);
    case 'torjaeger': return bildTorjaeger(team);
    case 'saison': return bildSaison(team);
    default: return null;
  }
}

/**
 * Ein Bild der Seite als PNG — aus dem Zwischenspeicher, solange der Stand
 * dieser Mannschaft derselbe ist (`standVon`); sonst gerendert und abgelegt.
 * `null` heißt: dafür gibt es nichts zu zeichnen.
 */
export async function siteImagePng(team: HandballTeamView, art: SiteImageArt, matchId: string | null): Promise<Buffer | null> {
  return bildMitKurzweg(`seite:${team.team_id}:${art}:${matchId ?? ''}:${standVon(team)}`, () => bildSvg(team, art, matchId));
}

/**
 * Das Wochenende (Freitag bis Sonntag) als PNG: alle Heimspiele des Vereins
 * nach Tag, mit Mannschaft, Gegner und Halle — zum Weiterschicken. Gecacht wie
 * die Bilder der Mannschaften, Schlüssel ist das Wochenende. `null`, wenn die
 * Übersicht keine Mannschaft hat.
 */
export async function wochenendePng(teams: readonly HandballTeamView[], now = new Date()): Promise<Buffer | null> {
  const erste = teams[0];
  if (!erste) return null;
  const we = spielWochenende(teams.flatMap(t => t.matches), now);
  const dieses = we.fr === naechstesWochenende(now).fr;
  return bildMitKurzweg(`seite:*:wochenende:${we.fr}:${dieses}:${standVon(teams)}`, () => wochenendeSvg(teams, erste, we, dieses, now));
}

function wochenendeSvg(teams: readonly HandballTeamView[], erste: HandballTeamView, we: ReturnType<typeof spielWochenende>, dieses: boolean, now: Date): string {
  const tage: Array<[string, string]> = [['Freitag', we.fr], ['Samstag', we.sa], ['Sonntag', we.so]];
  const spiele = teams.flatMap(t => t.matches.filter(m => m.is_home && m.status !== 'cancelled' && m.status !== 'postponed').map(m => ({ t, m })));
  const days = tage.map(([name, iso]) => ({
    label: `${name}, ${tagMonat(iso)}`,
    games: spiele
      .filter(x => TAG_ISO.format(new Date(x.m.starts_at)) === iso)
      .sort((a, b) => a.m.starts_at.localeCompare(b.m.starts_at))
      .map(({ t, m }) => ({ time: `${ZEIT.format(new Date(m.starts_at))} Uhr`, team: t.label, opponent: gegnerVon(m), venue: m.venue_name?.trim() || null })),
  }));
  const anzahl = days.reduce((a, d) => a + d.games.length, 0);
  const svg = renderWeekendSvg({
    title: `${dieses ? 'Dieses Wochenende' : 'Nächster Spieltag'}${anzahl === 0 ? '' : `: ${anzahl} Heimspiel${anzahl === 1 ? '' : 'e'}`}`,
    subtitle: `${clubName()} · ${tagMonat(we.fr)}–${tagMonat(we.so)}`,
    logo: logoDataUri(erste.team_id),
    days,
    empty: 'Von Freitag bis Sonntag ist kein Heimspiel angesetzt.',
    brand: bildMarke(now),
    palette: readPalette(),
  });
  return svg;
}

/**
 * Das Vereinslogo als quadratisches PNG (512×512) für Manifest, Home-Bildschirm
 * und Benachrichtigung — aus dem gespeicherten Logo, sonst ein Kreis in der
 * Vereinsfarbe mit den Initialen. Gecacht wie die anderen Bilder.
 */
export async function siteLogoPng(team: HandballTeamView, palette: FullPalette, groesse: 192 | 512 = 512): Promise<Buffer> {
  if (groesse === 192) {
    return (await zwischengespeichert(`logo:${team.team_id}:192`, async () => sharp(await siteLogoPng(team, palette, 512)).resize(192, 192).png().toBuffer(), LOGO_FRIST_MS))!;
  }
  return (await zwischengespeichert(`logo:${team.team_id}:512`, () => logoPng512(team, palette), LOGO_FRIST_MS))!;
}

async function logoPng512(team: HandballTeamView, palette: FullPalette): Promise<Buffer> {
  const uri = logoDataUri(team.team_id);
  let png: Buffer;
  if (uri) {
    const komma = uri.indexOf(',');
    const roh = Buffer.from(uri.slice(komma + 1), 'base64');
    png = await sharp(roh).resize(448, 448, { fit: 'inside', withoutEnlargement: false })
      .extend({ top: 32, bottom: 32, left: 32, right: 32, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toBuffer();
  } else {
    const initialen = team.name.split(/\s+/).filter(w => /^[A-ZÄÖÜ]/.test(w)).map(w => w[0]).join('').slice(0, 3) || 'HB';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette.primary}"/><stop offset="1" stop-color="${palette.secondary}"/></linearGradient></defs>
      <circle cx="256" cy="256" r="248" fill="url(#g)"/>
      <text x="256" y="300" text-anchor="middle" font-family="'Barlow Condensed','DejaVu Sans Condensed',sans-serif" font-weight="700" font-size="200" fill="${palette.accent}">${h(initialen)}</text>
    </svg>`;
    png = await sharp(Buffer.from(svg)).png().toBuffer();
  }
  return png;
}

// ---------------------------------------------------------------------------
// Schrift
// ---------------------------------------------------------------------------

/** Die Schriftdateien, die die Seite ausliefert — eine Allowlist, kein Verzeichnis-Listing. */
export const SITE_FONTS: Record<string, string> = {
  'BarlowCondensed-Bold.ttf': 'BarlowCondensed-Bold.ttf',
  'BarlowCondensed-SemiBold.ttf': 'BarlowCondensed-SemiBold.ttf',
  'Barlow-Regular.ttf': 'Barlow-Regular.ttf',
  'Barlow-Medium.ttf': 'Barlow-Medium.ttf',
  'Barlow-SemiBold.ttf': 'Barlow-SemiBold.ttf',
};

/**
 * Wo die Barlow-Dateien liegen: im Repo unter `apps/api/assets/fonts`, im
 * Image unter `/usr/share/fonts/truetype/barlow` (der Dockerfile kopiert nur
 * dorthin). Der erste Ort, an dem die Datei existiert, gewinnt; null heißt
 * 404, und das CSS fällt auf die Systemschrift zurück.
 */
export function siteFontPath(datei: string): string | null {
  const name = SITE_FONTS[datei];
  if (!name) return null;
  const kandidaten = [
    path.resolve(process.cwd(), 'assets/fonts'),
    path.resolve(__dirname, '../../assets/fonts'),
    '/usr/share/fonts/truetype/barlow',
  ];
  for (const dir of kandidaten) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Die Seite
// ---------------------------------------------------------------------------

/** Eine Mannschaft in der Mannschaftswahl: `group` ist die obere Ebene, `url` relativ (`../96300/`). */
export interface SiteTeamLink {
  id: string;
  label: string;
  group: HandballGroup | null;
  url: string;
}

export interface SiteRenderOptions {
  baseUrl: string;
  /**
   * Alle Mannschaften des Vereins für die Schaltflächen im Kopf — leer oder
   * eine, und es gibt keine. `url` ist relativ (`../96300/`), damit die Seite
   * unter jeder Wurzel funktioniert.
   */
  teams?: SiteTeamLink[];
  /** Ob Web-Push überhaupt möglich ist (VAPID vorhanden) — sonst zeigt die Seite nur Kalender und Feed. */
  pushEnabled: boolean;
  stand: string | null;
  now?: Date;
  /**
   * Der Vorschau-Schlüssel, wenn die Seite als Vorschau angefragt wurde
   * (`?vorab=…`): Dann zeigt sie zusätzlich die Fotos der Vereinsseite,
   * und alle Verweise innerhalb der Seite tragen den Schlüssel weiter.
   */
  vorschau?: string | null;
}

/**
 * Wer die Seite baut und wohin Rückmeldungen gehen — steht im Footer jeder
 * Mannschaftsseite, aus `SITE_OPERATOR` und `SITE_FEEDBACK_MAIL`. Eine
 * Eigenschaft der Instanz, nicht der Mannschaft; ohne beides fehlt der Satz.
 */
function betreiberZeile(): string {
  const wer = siteOperator();
  const mail = siteFeedbackMail();
  if (!wer && !mail) return '';
  const teile = [`Ein nicht-kommerzielles Projekt${wer ? ` von ${h(wer)}` : ''} — ohne Verbindung zum Verein oder zu handball.net.`];
  if (mail) teile.push(`Fehler gesehen, Wunsch offen? Feedback an <a href="mailto:${h(mail)}">${h(mail)}</a>.`);
  return `<div class="betreiber">${teile.join(' ')}</div>`;
}

let cssCache: { schluessel: string; text: string; hash: string } | null = null;

/** Der Stil der Seite samt Hash — nur neu gebaut, wenn sich die Vereinsfarben ändern. */
export function siteCssText(): { text: string; hash: string } {
  const palette = vervollstaendigePalette(readPalette());
  const schluessel = JSON.stringify(palette);
  if (!cssCache || cssCache.schluessel !== schluessel) {
    const text = siteCss(palette);
    cssCache = { schluessel, text, hash: inhaltsHash(text) };
  }
  return cssCache;
}

/** Inline-Icons für die Kanäle — `currentColor`, damit sie die Farbe der Kachel nehmen. */
const ICON: Record<'bell' | 'send' | 'calendar' | 'rss' | 'share' | 'app', string> = {
  app: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M7 1h10a2 2 0 0 1 2 2v18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2zm0 3v14h10V4zm5 15.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM11 6h2v5h2.5L12 14.5 8.5 11H11z"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 16a3 3 0 0 0-2.4 1.2L8.9 13.7a3 3 0 0 0 0-3.4l6.7-3.5A3 3 0 1 0 15 5a3 3 0 0 0 .1.7L8.4 9.2a3 3 0 1 0 0 5.6l6.7 3.5A3 3 0 1 0 18 16z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a6 6 0 0 0-6 6v4.2L4 15v1h16v-1l-2-2.8V8a6 6 0 0 0-6-6zm0 20a2.6 2.6 0 0 0 2.5-2h-5A2.6 2.6 0 0 0 12 22z"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 2v2H4v18h16V4h-3V2h-2v2H9V2zm-1 8h12v10H6z"/></svg>',
  rss: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4a16 16 0 0 1 16 16h-3A13 13 0 0 0 4 7zm0 6a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7zm2 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/></svg>',
};

/**
 * Der Teilen-Knopf. Ohne Skript bleibt er verborgen; das Skript (`app.js`)
 * öffnet auf dem Telefon das Teilen-Menü des Geräts — mit dem Bild als Datei,
 * wo das Gerät das kann — und zeigt sonst ein Fenster mit WhatsApp, Telegram,
 * Facebook, LinkedIn, Link kopieren, Bild kopieren und Bild speichern.
 * `url` ist absolut (der Empfänger sieht sie), `bild` relativ zur Seite.
 */
function teilenHtml(o: { url: string; titel: string; text: string; bild?: string | null }): string {
  return `<button type="button" class="btn teilen" data-teilen data-url="${h(o.url)}" data-titel="${h(o.titel)}" data-text="${h(o.text)}"${o.bild ? ` data-bild="${h(o.bild)}"` : ''} hidden>${ICON.share} Teilen</button>`;
}

/** Der Kalendertag in deutscher Ortszeit als Zahl — für „heute", „morgen", „in 6 Tagen". */
const TAG_ISO = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Europe/Berlin' });
function tageBis(ziel: Date, now: Date): number {
  const tag = (d: Date) => { const [y, m, t] = TAG_ISO.format(d).split('-').map(Number); return Date.UTC(y, m - 1, t) / 86400000; };
  return tag(ziel) - tag(now);
}
function inTagen(ziel: Date, now: Date): string {
  const n = tageBis(ziel, now);
  if (n <= 0) return 'Heute';
  if (n === 1) return 'Morgen';
  if (n < 14) return `In ${n} Tagen`;
  const wochen = Math.round(n / 7);
  return `In ${wochen} Wochen`;
}

function formStrip(team: HandballTeamView): string {
  const letzte = gespielt(team).slice(-5);
  if (letzte.length === 0) return '';
  const punkte = letzte.map(m => `<i class="${m.won === true ? 'w' : m.won === false ? 'l' : ''}" title="${h(`${standHeimGast(m)} ${m.is_home ? 'gegen' : 'bei'} ${gegnerVon(m)}`)}"></i>`).join('');
  return `<span class="form" aria-label="Form der letzten ${letzte.length} Spiele">${punkte}</span>`;
}

/**
 * Die Navigation jeder Seite, oben im Kopf über Logo und Titel: fünf große
 * Kästen (Herren, Damen, Jugend männlich, Jugend weiblich, Kinder), ein Klick klappt darunter die
 * Mannschaften auf. Reine `<details>` — kein Skript nötig; mit `name` ist
 * immer nur einer offen, beim Laden keiner (Platz); auf der Mannschaftsseite
 * ist der eigene Bereich markiert und die Kästen sind flacher. Eine
 * Gruppe ohne Mannschaft bleibt als gedämpfter Kasten stehen, damit die fünf
 * immer da sind. Die Verweise sind relativ (`url` je Seite), `anhang` trägt
 * den Vorschau-Schlüssel weiter.
 */
/**
 * Die Bereichskästen im Kopf. Vorne „Alle": der Weg zur Startseite mit allen
 * Mannschaften (`start` ist ihre Adresse von hier aus; auf der Startseite
 * selbst `null`, dann ist der Kasten markiert).
 */
function gruppenKaesten(teams: SiteTeamLink[], aktuell: string | null, anhang = '', flach = false, start: string | null = null): string {
  const spalten: Array<{ id: string; label: string; teams: SiteTeamLink[] }> = HANDBALL_GROUPS.map(g => ({ id: g.id, label: g.label, teams: teams.filter(t => t.group === g.id) }));
  const weitere = teams.filter(t => t.group === null);
  if (weitere.length > 0) spalten.push({ id: 'weitere', label: 'Weitere', teams: weitere });
  const alle = start === null
    ? `<a class="kasten alle aktiv" href="./" aria-current="page"><span class="kopf"><b>Alle</b><small>alle Mannschaften</small></span></a>`
    : `<a class="kasten alle" href="${h(start + anhang)}"><span class="kopf"><b>Alle</b><small>alle Mannschaften</small></span></a>`;
  return `<nav class="kaesten${flach ? ' flach' : ''}" aria-label="Mannschaften nach Bereich">${alle}${spalten.map(g => {
    const offen = g.teams.some(t => t.id === aktuell);
    return g.teams.length === 0
      ? `<div class="kasten leer" aria-disabled="true"><span class="kopf"><b>${h(g.label)}</b><small>keine Mannschaft</small></span></div>`
      : `<details class="kasten${offen ? ' aktiv' : ''}" name="bereich" data-bereich="${h(g.id)}">
    <summary><span class="kopf"><b>${h(g.label)}</b><small>${g.teams.length} ${g.teams.length === 1 ? 'Mannschaft' : 'Mannschaften'}</small></span></summary>
    <ul class="liste">${g.teams.map(t => `<li><a href="${h(t.url + anhang)}"${t.id === aktuell ? ' aria-current="page"' : ''}>${h(t.label)}</a></li>`).join('')}</ul>
  </details>`;
  }).join('')}</nav>`;
}

/**
 * Der Kopf: Logo, Name, Wettbewerb — und die Saison in Kacheln (Platz,
 * Punkte, Bilanz, Tore, Form, nächstes Spiel), damit die Frage „wie
 * stehen wir?" beantwortet ist, bevor jemand scrollt.
 */
function heroHtml(team: HandballTeamView, logo: string | null, now: Date, mannschaften: SiteTeamLink[], anhang = '', startUrl = '../', verpassen = ''): string {
  const zeile = eigeneZeile(team);
  const aktuell = aktuellesSpiel(team.matches);
  const saison = saisonLabel(aktuell?.season_id);
  const wettbewerb = [team.championship_name, team.standings[0]?.competition_name ?? aktuell?.competition_name].filter(Boolean).join(' · ');
  const initialen = team.name.split(/\s+/).filter(w => /^[A-ZÄÖÜ]/.test(w)).map(w => w[0]).join('').slice(0, 3) || 'HB';
  const naechstes = team.next_match;
  const teams = team.standings[0]?.rows.length ?? 0;
  const form = formStrip(team);
  // Drei Kennzahlen im Kopf: Platz, Form, nächstes Spiel. Punkte, Bilanz und Tore stehen in der Tabellenkarte.
  const kacheln: string[] = [];
  if (zeile) {
    kacheln.push(`<div class="stat"><b class="a">${zeile.position}.<small>von ${teams}</small></b><span>Platz</span></div>`);
  }
  if (form) kacheln.push(`<div class="stat"><b>${form}</b><span>Form</span></div>`);
  if (naechstes) {
    const start = new Date(naechstes.starts_at);
    kacheln.push(`<div class="stat"><b class="a"${naechstes.is_live ? '' : ` data-countdown="${h(naechstes.starts_at)}"`}>${naechstes.is_live ? 'Jetzt' : h(inTagen(start, now))}</b><span>${naechstes.is_live ? 'Spiel läuft' : `Nächstes Spiel · ${h(DATUM_KURZ.format(start))}`}</span></div>`);
  }
  return `<header class="hero"><div class="wrap">
  <button type="button" class="theme" data-theme-toggle hidden aria-label="Farbschema: automatisch" title="Farbschema: automatisch">◐</button>
  ${verpassen}
  <a class="heim" href="${h(startUrl + anhang)}" aria-label="Zur Startseite">${logo ? `<img class="logo" src="${logo}" alt="">` : `<div class="initialen" aria-hidden="true">${h(initialen)}</div>`}</a>
  <div class="verein"><a class="heim titel" href="${h(startUrl + anhang)}"><span class="kicker">${h(clubName())}</span></a></div>
  ${gruppenKaesten(mannschaften, team.team_id, anhang, true, startUrl)}
  <div class="teaminfo">
    <h1>${h(team.label)}</h1>
    <div class="sub">${h(wettbewerb)}${saison ? ` · Saison ${h(saison)}` : ''}</div>
  </div>
  ${kacheln.length > 0 ? `<div class="stats">${kacheln.join('')}</div>` : ''}
</div></header>
<div class="mini" data-mini hidden inert>
  <a class="mlogo" href="${h(startUrl + anhang)}" aria-label="Zur Startseite">${logo ? `<img src="${logo}" alt="">` : `<span class="ini" aria-hidden="true">${h(initialen)}</span>`}</a>
  <b>${h(team.label)}</b>
  <span class="minfo">${[zeile ? `${zeile.position}. Platz` : '', naechstes ? (naechstes.is_live ? `läuft gegen ${gegnerVon(naechstes)}` : `${DATUM_KURZ.format(new Date(naechstes.starts_at))} ${naechstes.is_home ? 'gegen' : 'bei'} ${gegnerVon(naechstes)}`) : ''].filter(Boolean).map(x => h(x)).join(' · ')}</span>
  <button type="button" class="nachoben" data-nach-oben aria-label="Nach oben">↑</button>
</div>`;
}

/**
 * Der Gegner-Steckbrief unter dem nächsten Spiel — dieselben drei Dinge wie
 * in der Ankündigung des Bots (`gegnerSteckbrief`): seine Tabellenzeile, seine
 * letzten Ergebnisse (aus dem Spielplan, den der Tageslauf für ihn geholt
 * hat — die Seite selbst holt nichts) und der Direktvergleich aus den
 * eigenen Spielen. Leer, wenn es zu ihm nichts zu sagen gibt.
 */
function gegnerSteckbriefHtml(team: HandballTeamView, m: HandballMatchView, now: Date): string {
  return steckbriefHtml(team, m.is_home ? m.away_id : m.home_id, gegnerVon(m), m.match_id, now);
}

/** Der Steckbrief zu einer beliebigen Mannschaft der Staffel; `ausser` ist ein Spiel, das im Direktvergleich nicht mitzählt. */
function steckbriefHtml(team: HandballTeamView, gid: string, name: string, ausser: string, now: Date): string {
  const zeile = team.standings.flatMap(s => s.rows).find(r => r.teamId === gid);
  const form = opponentFormFor(gid);
  const letzte = (form?.matches ?? [])
    .filter(g => g.status === 'finished' && g.scoreHome !== null && g.scoreAway !== null && g.id !== ausser)
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
    .slice(0, 5)
    .map(g => {
      const heim = g.homeId === gid;
      const eigene = heim ? g.scoreHome! : g.scoreAway!;
      const andere = heim ? g.scoreAway! : g.scoreHome!;
      return { klasse: eigene > andere ? 'w' : eigene < andere ? 'l' : '', text: `${g.scoreHome}:${g.scoreAway} ${heim ? 'gegen' : 'bei'} ${heim ? g.awayName : g.homeName}`, datum: datumKurz(new Date(g.startsAt), now) };
    });
  const duelle = team.matches.filter(h => h.match_id !== ausser && (h.status === 'finished' || h.rated) && (h.is_home ? h.away_id : h.home_id) === gid
    && h.score_home !== null && h.score_away !== null);
  if (!zeile && letzte.length === 0 && duelle.length === 0) return '';
  const logo = logoDataUri(gid);
  const initialen = name.split(/\s+/).filter(w => /^[A-ZÄÖÜ]/.test(w)).map(w => w[0]).join('').slice(0, 3) || '?';
  const zeilen: string[] = [];
  if (letzte.length > 0) {
    zeilen.push(`<div class="zeile"><span class="lbl">Zuletzt</span><span class="form">${letzte.slice().reverse().map(l => `<i class="${l.klasse}" title="${h(`${l.text} · ${l.datum}`)}"></i>`).join('')}</span><span class="res">${letzte.slice(0, 3).map(l => h(l.text)).join(' · ')}</span></div>`);
  }
  if (duelle.length > 0) {
    zeilen.push(`<div class="zeile"><span class="lbl">${duelle.length === 1 ? 'Hinspiel' : 'Bisher'}</span><span class="res">${duelle.map(d => `${standHeimGast(d)} (${d.is_home ? 'H' : 'A'})`).join(' · ')}</span></div>`);
  }
  return `<div class="gegner">
    <div class="kopf">${logo ? `<img src="${logo}" alt="">` : `<span class="ini" aria-hidden="true">${h(initialen)}</span>`}<div><b>${h(name)}</b><span>${zeile ? `${zeile.position}. Platz · ${zeile.won}-${zeile.drawn}-${zeile.lost} · ${zeile.goalsFor}:${zeile.goalsAgainst} Tore · ${punkteText(zeile)} Punkte` : 'Noch ohne Tabellenzeile'}</span></div></div>
    ${zeilen.join('')}
  </div>`;
}

/**
 * Der Spielverlauf als Kurve: die Führung aus eigener Sicht je Spielminute,
 * über der Nulllinie in Grün, darunter in Rot — eine Grafik, die ohne Namen
 * auskommt und deshalb auch ohne den zweiten Schalter erscheinen darf.
 * Null, wenn die Torfolge fehlt, leer ist oder keine Minuten trägt.
 */
export function spielverlaufSvg(m: HandballMatchView): string | null {
  const events = (m.events ?? []).filter(e => e.minute !== null && e.goal);
  if (events.length < 2) return null;
  const punkte = events.map(e => ({ min: Math.max(0, e.minute!), diff: m.is_home ? e.home - e.away : e.away - e.home, home: e.home, away: e.away }));
  const ende = Math.max(60, Math.ceil(Math.max(...punkte.map(p => p.min))));
  const maxDiff = Math.max(3, ...punkte.map(p => Math.abs(p.diff)));
  const W = 600, H = 170, L = 30, R = 46, T = 14, B = 26;
  const x = (min: number) => L + (min / ende) * (W - L - R);
  const y = (d: number) => T + ((maxDiff - d) / (2 * maxDiff)) * (H - T - B);
  const y0 = y(0);
  // Stufenkurve: der Stand gilt, bis das nächste Tor fällt.
  let d = `M ${x(0).toFixed(1)} ${y0.toFixed(1)}`;
  let letzte = 0;
  for (const p of punkte) {
    d += ` H ${x(p.min).toFixed(1)} V ${y(p.diff).toFixed(1)}`;
    letzte = p.diff;
  }
  d += ` H ${x(ende).toFixed(1)}`;
  const flaeche = `${d} V ${y0.toFixed(1)} Z`;
  const ticks = [0, 15, 30, 45, 60].filter(t => t <= ende);
  const halbzeit = m.halftime_home !== null && m.halftime_away !== null
    ? `${m.halftime_home}:${m.halftime_away}` : null;
  const gid = `sv${m.match_id.replace(/[^a-z0-9]/gi, '')}`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Spielverlauf: Führung je Spielminute">
<defs><linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="0" y1="${T}" x2="0" y2="${H - B}"><stop offset="0" stop-color="var(--win)" stop-opacity=".35"/><stop offset="${((y0 - T) / (H - T - B)).toFixed(4)}" stop-color="var(--win)" stop-opacity=".35"/><stop offset="${((y0 - T) / (H - T - B)).toFixed(4)}" stop-color="var(--loss)" stop-opacity=".35"/><stop offset="1" stop-color="var(--loss)" stop-opacity=".35"/></linearGradient></defs>
${ticks.map(t => `<line x1="${x(t).toFixed(1)}" y1="${T}" x2="${x(t).toFixed(1)}" y2="${H - B}" stroke="var(--line)" stroke-width="1"${t === 30 ? ' stroke-dasharray="4 4"' : ''}/><text x="${x(t).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${t}${t === 30 && halbzeit ? ` · HZ ${halbzeit}` : ''}</text>`).join('')}
<text x="${L - 6}" y="${(y(maxDiff) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">+${maxDiff}</text>
<text x="${L - 6}" y="${(y(-maxDiff) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">−${maxDiff}</text>
<line x1="${L}" y1="${y0.toFixed(1)}" x2="${W - R}" y2="${y0.toFixed(1)}" stroke="var(--muted)" stroke-width="1"/>
<path d="${flaeche}" fill="url(#${gid})" stroke="none"/>
<path d="${d}" fill="none" stroke="var(--hd)" stroke-width="2.5" stroke-linejoin="round"/>
<text x="${(W - R + 6).toFixed(1)}" y="${(y(letzte) + 4).toFixed(1)}" font-size="12" font-weight="700" fill="${letzte > 0 ? 'var(--win)' : letzte < 0 ? 'var(--loss)' : 'var(--muted)'}">${letzte > 0 ? '+' : ''}${letzte}</text>
</svg>`;
}

/** Die Torfolge als Zeile: „1:0 (2.) · 1:1 (4.) …" — der Stand nach jedem Tor, aus Sicht der Quelle (Heim:Gast). */
function torfolgeText(m: HandballMatchView): string {
  const tore = (m.events ?? []).filter(e => e.goal);
  if (tore.length === 0) return '';
  // Das Tor gehört der Seite, deren Stand gestiegen ist — erkennbar am Stand davor.
  let vorher = { home: 0, away: 0 };
  const teile = tore.map(e => {
    const eigenes = m.is_home ? e.home > vorher.home : e.away > vorher.away;
    vorher = { home: e.home, away: e.away };
    const stand = `${e.home}:${e.away}`;
    const minute = e.minute !== null ? ` (${Math.ceil(e.minute)}.)` : '';
    return eigenes ? `<b>${stand}</b>${minute}` : `${stand}${minute}`;
  });
  return `<p class="torfolge">${teile.join(' · ')}</p>`;
}

/**
 * Der Spielverlauf zu einem beendeten Spiel, aufklappbar. Er kommt ohne Namen
 * aus und steht immer da. Den Spielbericht der Quelle zeigt die Seite nicht
 * mehr — es bleibt der Verweis auf den Spielberichtsbogen (PDF). Leer, wenn
 * es keine Torfolge gibt. Immer zugeklappt, auch unter dem letzten Spiel.
 */
function spielDetailsHtml(m: HandballMatchView): string {
  const verlauf = spielverlaufSvg(m);
  if (!verlauf) return '';
  return `<details class="more"><summary>Spielverlauf</summary>
    <div class="verlauf">${verlauf}</div>${torfolgeText(m)}
  </details>`;
}

/**
 * Wer ein Tor geworfen hat: bei der eigenen Mannschaft der Name aus dem Kader
 * (die Spieler-ID ist die Brücke, die Torfolge selbst maskiert bei der
 * Jugend), beim Gegner und ohne Kadereintrag die Rückennummer.
 */
function werfer(e: { player_id?: string | null; number?: number | null }, eigenes: boolean, namen: Map<string, string>): string | null {
  const name = eigenes && e.player_id ? namen.get(e.player_id) : undefined;
  if (name) return name;
  return e.number !== null && e.number !== undefined ? `Nr. ${e.number}` : null;
}

/** Die Steuerung der Live-Meldungen: Vibration an oder aus — gilt nur für dieses Gerät, das Skript blendet sie ein. */
const VIBRATION_KNOPF = '<button type="button" class="btn ghost" data-vibration aria-pressed="true" hidden>📳 Vibration an</button>';

/**
 * Die Live-Ansicht anstelle von „Nächstes Spiel": Spielstand klassisch (Heim
 * links, Gast rechts), Spieluhr und Halbzeit, die letzten Tore mit Werfer und
 * der Stand der Quelle. Liest nur, was der Live-Takt gespeichert hat; fehlt
 * es (der Takt ist aus oder die Quelle meldet noch nichts), bleibt es beim
 * Spielstand der Spielliste und einem Hinweis.
 */
function liveSpielHtml(team: HandballTeamView, m: HandballMatchView, now: Date): string {
  const live = m.live;
  const start = new Date(m.starts_at);
  const mitLive = live !== null && live.home !== null && live.away !== null;
  const heim = mitLive ? live.home : m.score_home;
  const gast = mitLive ? live.away : m.score_away;
  const stand = heim !== null && gast !== null ? `${heim}:${gast}` : '–:–';
  const uhr = [live?.minute ? `${live.minute} Min.` : null, live?.block ?? null].filter(Boolean).join(' · ');
  const hz = live?.halftime ? `Halbzeit ${live.halftime.home}:${live.halftime.away}` : '';
  const halle = [m.venue_name, m.venue_address].filter(Boolean).join(', ');
  const namen = new Map(rosterFor(team.team_id).map(r => [r.playerId, r.name] as const));
  // Wem das Tor gehört, sagt die Quelle (is_home); ältere Stände ohne das Feld verrät der Stand davor.
  let davor = { home: 0, away: 0 };
  const eintraege = live ? live.items.map(e => {
    const fuerHeim = typeof e.is_home === 'boolean' ? e.is_home : e.home > davor.home ? true : e.away > davor.away ? false : null;
    davor = { home: e.home, away: e.away };
    const fuer = fuerHeim === null ? null : fuerHeim ? m.home_name : m.away_name;
    const wer = fuerHeim === null ? null : werfer(e, fuerHeim === m.is_home, namen);
    const eigenes = fuerHeim !== null && fuerHeim === m.is_home;
    return `<li${eigenes ? ' class="eigen"' : ''}><span class="min">${e.minute !== null ? `${Math.max(1, Math.ceil(e.minute))}.` : '–'}</span> Tor${fuer ? ` für ${h(fuer)}` : ''}${wer ? ` <span class="werfer">(${h(wer)})</span>` : ''} · <b>${e.home}:${e.away}</b></li>`;
  }).reverse() : [];
  const TICKER_SICHTBAR = 6;
  const tore = eintraege.slice(0, TICKER_SICHTBAR).join('');
  const aeltere = eintraege.slice(TICKER_SICHTBAR);
  const vorMin = live ? Math.max(0, Math.round((now.getTime() - Date.parse(live.fetched_at)) / 60000)) : null;
  return `<section class="card dark next live s-next" id="naechstes">
  <h2>Läuft gerade <span class="badge live">Live</span></h2>
  <div class="livestand" aria-label="Spielstand" data-stand="${heim !== null && gast !== null ? stand : ''}" data-heim="${m.is_home ? '1' : '0'}">
    <span class="seite">${h(m.home_name)}</span>
    <b class="tore-gross">${stand}</b>
    <span class="seite">${h(m.away_name)}</span>
  </div>
  <div class="info">
    <span>${uhr ? h(uhr) : 'Anwurf war um ' + h(ZEIT.format(start)) + ' Uhr'}${hz ? ` · ${h(hz)}` : ''}</span>
    <span>${m.is_home ? 'Heimspiel' : 'Auswärts'}${halle ? ` · 📍 ${h(halle)}` : ''}</span>
    <span class="muted small">${h(m.competition_name)}${m.round ? `, ${m.round}. Spieltag` : ''}</span>
  </div>
  ${tore ? `<ol class="livetore" aria-label="Letzte Tore">${tore}</ol>` : ''}
  ${aeltere.length > 0 ? `<details class="more ticker"><summary>Alle ${eintraege.length} Tore</summary><ol class="livetore" aria-label="Frühere Tore">${aeltere.join('')}</ol></details>` : ''}
  <p class="muted small" style="margin:10px 0 0">${vorMin !== null ? (vorMin < 1 ? 'Stand gerade eben' : `Stand vor ${vorMin} Min.`) : 'Der Zwischenstand kommt, sobald handball.net ihn liefert'} · die Seite aktualisiert sich selbst.</p>
  <div class="row" style="margin-top:14px">
    <a class="btn ghost" href="${h(m.url)}" target="_blank" rel="noopener noreferrer">Live auf handball.net</a>
    ${VIBRATION_KNOPF}
  </div>
</section>`;
}

function naechstesSpielHtml(team: HandballTeamView, now: Date, baseUrl: string): string {
  const m = team.next_match;
  if (!m) {
    return `<section class="card dark next s-next" id="naechstes"><h2>Nächstes Spiel</h2><p class="muted">Kein weiteres Spiel angesetzt.</p></section>`;
  }
  if (m.is_live) return liveSpielHtml(team, m, now);
  const start = new Date(m.starts_at);
  const halle = [m.venue_name, m.venue_address].filter(Boolean).join(', ');
  const routen = routenLinks(m);
  const heute = tageBis(start, now) <= 0;
  return `<section class="card dark next s-next" id="naechstes">
  <h2>Nächstes Spiel <span class="badge" data-countdown="${h(m.starts_at)}">${h(inTagen(start, now))}</span></h2>
  <img class="bild" src="./bild/spiel.png" width="800" height="450" alt="${h(`${m.home_name} gegen ${m.away_name}`)}" loading="eager">
  <div class="info">
    <b>${m.is_home ? `gegen ${h(gegnerVon(m))}` : `bei ${h(gegnerVon(m))}`}</b>
    <span>${heute ? 'Heute' : h(DATUM_LANG.format(start))}, ${h(ZEIT.format(start))} Uhr · ${m.is_home ? 'Heimspiel' : 'Auswärts'}</span>
    ${halle ? `<span>📍 ${h(halle)}</span>` : ''}
    <span class="muted small">${h(m.competition_name)}${m.round ? `, ${m.round}. Spieltag` : ''}</span>
  </div>
  <p class="livehinweis"><span class="punkt" aria-hidden="true"></span><span><b>Live ab Anwurf:</b> Ab ${h(ZEIT.format(start))} Uhr zeigt diese Seite hier den Spielstand und die Tore. Sie aktualisiert sich alle 30 Sekunden, meldet Tore mit Vibration und schaltet sich 20 Minuten vorher selbst um.</span></p>
  ${gegnerSteckbriefHtml(team, m, now)}
  <div class="row" style="margin-top:14px">
    ${teilenHtml({ url: baseUrl, titel: `${m.home_name} gegen ${m.away_name}`, text: `${m.home_name} gegen ${m.away_name} · ${DATUM_LANG.format(start)}, ${ZEIT.format(start)} Uhr${halle ? ` · ${halle}` : ''}`, bild: './bild/spiel.png' }).replace('class="btn teilen"', 'class="btn ghost teilen"')}
    ${routen.map(r => `<a class="btn ghost" href="${h(r.href)}" target="_blank" rel="noopener noreferrer">🧭 ${h(r.label)}</a>`).join('')}
    <a class="btn ghost" href="${h(m.url)}" target="_blank" rel="noopener noreferrer">Spielseite auf handball.net</a>
  </div>
</section>`;
}

function letztesSpielHtml(team: HandballTeamView, baseUrl: string): string {
  const m = team.last_match;
  if (!m || m.score_home === null || m.score_away === null) return '';
  const start = new Date(m.starts_at);
  const ausgang = m.won === true ? 'Sieg' : m.won === false ? 'Niederlage' : 'Unentschieden';
  const hz = m.halftime_home !== null && m.halftime_away !== null ? `Halbzeit ${m.halftime_home}:${m.halftime_away}` : '';
  return `<section class="card result s-last" id="letztes">
  <h2>Letztes Spiel</h2>
  <img class="bild" src="./bild/endstand.png?match=${encodeURIComponent(m.match_id)}" width="800" height="450" alt="${h(`Endstand ${m.home_name} ${m.score_home}:${m.score_away} ${m.away_name}`)}" loading="lazy">
  <div class="row" style="margin-top:12px;justify-content:space-between">
    <div>
      <div class="stand">${standHeimGast(m)} <span class="muted" style="font-size:1rem;font-weight:500">${ausgang}${m.rated ? ' (gewertet)' : ''}</span></div>
      <div class="muted">${m.is_home ? 'gegen' : 'bei'} ${h(gegnerVon(m))} · ${h(DATUM_LANG.format(start))}${hz ? ` · ${hz}` : ''}</div>
    </div>
    <div class="row">
      ${teilenHtml({ url: `${baseUrl}spiel/${encodeURIComponent(m.match_id)}`, titel: `${m.home_name} ${m.score_home}:${m.score_away} ${m.away_name}`, text: `Endstand: ${m.home_name} ${m.score_home}:${m.score_away} ${m.away_name}`, bild: `./bild/endstand.png?match=${encodeURIComponent(m.match_id)}` })}
      <a class="btn" href="${h(`./spiel/${encodeURIComponent(m.match_id)}`)}">Spielseite</a>
      ${m.report_url ? `<a class="btn" href="${h(m.report_url)}" target="_blank" rel="noopener noreferrer">Spielberichtsbogen (PDF)</a>` : ''}
      <a class="btn" href="${h(m.url)}" target="_blank" rel="noopener noreferrer">handball.net</a>
    </div>
  </div>
  ${spielDetailsHtml(m)}
</section>`;
}

/**
 * ▲/▼ gegenüber dem Stand nach dem **vorigen Spieltag** (`tendenzReferenz`),
 * nicht gegenüber dem letzten Abruf: Wer am Samstag spielt, während der
 * Tabellenführer erst am Sonntag dran ist, steht dazwischen kurz oben — das
 * ist kein Aufstieg, und der Sonntag danach kein Abstieg.
 */
function tendenz(row: HandballStandingRow, referenz: HandballStandingRow[] | null): string {
  if (!referenz) return '';
  const davor = referenz.find(r => r.teamId === row.teamId);
  if (!davor || davor.position === row.position) return '';
  return davor.position > row.position
    ? `<i class="up" title="${h(`von Platz ${davor.position} auf ${row.position} geklettert`)}">▲</i>`
    : `<i class="down" title="${h(`von Platz ${davor.position} auf ${row.position} gerutscht`)}">▼</i>`;
}

function tabelleHtml(team: HandballTeamView, now: Date, saison = ''): string {
  const s = team.standings[0];
  if (!s || s.rows.length === 0) return '';
  const spitze = Math.max(...s.rows.map(r => r.played));
  const referenz = tendenzReferenz(s);
  const gegnerNaechster = team.next_match ? (team.next_match.is_home ? team.next_match.away_id : team.next_match.home_id) : null;
  // Jede fremde Zeile ist antippbar und öffnet den Steckbrief der Mannschaft; ohne Skript bleibt sie eine gewöhnliche Zeile.
  const steckbriefe = new Map(s.rows.filter(r => r.teamId !== team.team_id).map(r => [r.teamId, steckbriefHtml(team, r.teamId, r.teamName, '', now)] as const).filter(([, html]) => html !== ''));
  const zeilen = s.rows.map(r => `<tr class="${r.teamId === team.team_id ? 'own' : ''}"${steckbriefe.has(r.teamId) ? ` data-sb="sb-${h(r.teamId)}" tabindex="0" role="button" aria-label="${h(`${r.teamName}: Steckbrief öffnen`)}"` : ''}>
    <td class="pos">${r.position}</td>
    <td class="name t">${h(r.teamName)}${tendenz(r, referenz)}${r.teamId === gegnerNaechster ? ' <span class="muted small">· nächster Gegner</span>' : ''}</td>
    <td${r.played < spitze ? ' class="muted"' : ''}>${r.played}</td>
    <td class="hide-sm">${r.won}</td><td class="hide-sm">${r.drawn}</td><td class="hide-sm">${r.lost}</td>
    <td class="hide-sm">${r.goalsFor}:${r.goalsAgainst}</td>
    <td>${r.goalsDiff > 0 ? '+' : ''}${r.goalsDiff}</td>
    <td class="pkt">${punkteText(r)}</td>
  </tr>`).join('');
  const spieltag = s.rows[0]?.round ?? 0;
  const unvollstaendig = s.rows.some(r => r.played < spitze);
  const hinweise = [
    referenz ? `▲▼ gegenüber dem Stand nach dem ${spieltag - 1}. Spieltag` : null,
    unvollstaendig ? 'Sp grau: weniger Spiele als die Spitze' : null,
  ].filter(Boolean);
  const eigene = s.rows.find(r => r.teamId === team.team_id);
  const kennzahlen = eigene ? `<dl class="kenn" aria-label="Unsere Zahlen">
    <div><dt>Punkte</dt><dd>${punkteText(eigene)}<small>${eigene.played} Sp.</small></dd></div>
    <div><dt>Siege · Unent. · Niederl.</dt><dd>${eigene.won}-${eigene.drawn}-${eigene.lost}</dd></div>
    <div><dt>Tore</dt><dd>${eigene.goalsFor}:${eigene.goalsAgainst}<small>${eigene.goalsDiff > 0 ? '+' : ''}${eigene.goalsDiff}</small></dd></div>
  </dl>` : '';
  const overlays = [...steckbriefe].map(([id, html]) => `<dialog class="popup steckbrief" id="sb-${h(id)}" aria-label="${h(`Steckbrief ${s.rows.find(r => r.teamId === id)?.teamName ?? ''}`)}">${html}<form method="dialog" class="schliessen"><button class="btn ghost" type="submit">Schließen</button></form></dialog>`).join('');
  return `<section class="card s-table" id="tabelle">
  <h2>Tabelle</h2>
  <p class="muted small" style="margin:0 0 10px">${h(s.competition_name)}${spieltag ? ` · nach dem ${spieltag}. Spieltag` : ''}${unvollstaendig ? ' · Spieltag noch nicht komplett' : ''}</p>
  ${kennzahlen}
  <div style="overflow-x:auto"><table>
    <thead><tr><th>#</th><th class="name">Mannschaft</th><th>Sp</th><th class="hide-sm">S</th><th class="hide-sm">U</th><th class="hide-sm">N</th><th class="hide-sm">Tore</th><th>Diff</th><th>Pkt</th></tr></thead>
    <tbody>${zeilen}</tbody>
  </table></div>
  ${hinweise.length > 0 || steckbriefe.size > 0 ? `<p class="legend">${[...hinweise.map(x => h(x!)), ...(steckbriefe.size > 0 ? ['Zeile antippen: Steckbrief der Mannschaft'] : [])].join(' · ')}</p>` : ''}
  ${saison}
  ${overlays}
</section>`;
}

function spielplanHtml(team: HandballTeamView, now: Date): string {
  if (team.matches.length === 0) return '';
  const naechstesId = team.next_match?.match_id ?? null;
  // Eingeklappt bleiben drei Spiele sichtbar: das nächste und die zwei danach — am Saisonende die letzten drei.
  const ab = naechstesId ? team.matches.findIndex(m => m.match_id === naechstesId) : -1;
  const start3 = ab >= 0 ? Math.max(0, Math.min(ab, team.matches.length - 3)) : Math.max(0, team.matches.length - 3);
  const kurz = new Set(team.matches.slice(start3, start3 + 3).map(m => m.match_id));
  const items = team.matches.map(m => {
    const start = new Date(m.starts_at);
    const status = statusWort(m);
    const mitStand = m.score_home !== null && m.score_away !== null && (m.status === 'finished' || m.rated || m.is_live);
    let ergebnis: string;
    if (mitStand) {
      const klasse = m.is_live ? '' : m.won === true ? 'w' : m.won === false ? 'l' : '';
      ergebnis = `<span class="e ${klasse}" title="${h(m.is_live ? 'Zwischenstand' : m.won === true ? 'gewonnen' : m.won === false ? 'verloren' : 'unentschieden')}">${standHeimGast(m)}</span>`;
    } else if (status) {
      ergebnis = `<span class="e o">${h(status)}</span>`;
    } else {
      ergebnis = `<span class="e o">${h(ZEIT.format(start))} Uhr</span>`;
    }
    const gespieltEintrag = mitStand && !m.is_live;
    return `<li${m.match_id === naechstesId ? ' class="next"' : ''}${kurz.has(m.match_id) ? ' data-kurz' : ''} data-ha="${m.is_home ? 'heim' : 'aus'}" data-st="${gespieltEintrag ? 'gespielt' : 'kommend'}">
      <span class="d">${h(datumKurz(start, now))}<small>${m.round ? `${m.round}. Spieltag` : h(ZEIT.format(start))}</small></span>
      <span class="g"><a class="titel" href="${h(m.url)}" target="_blank" rel="noopener noreferrer">${h(gegnerVon(m))}</a><div class="ha">${m.is_home ? 'Heim' : 'Auswärts'}${m.venue_name ? ` · ${h(m.venue_name)}` : ''}${status && mitStand ? ` · ${h(status)}` : ''}${gespieltEintrag ? ` · <a class="spielseite" href="${h(`./spiel/${encodeURIComponent(m.match_id)}`)}">Spielseite →</a>` : ''}</div></span>
      ${ergebnis}
      ${mitStand && !m.is_live ? spielDetailsHtml(m) : ''}
    </li>`;
  }).join('');
  const bilanz = gespielt(team);
  const kPlan = klappe('spielplan', `${team.matches.length > 3 ? `${kurz.size} von ${team.matches.length} Spielen` : ''}`);
  return `<section class="card s-plan" id="spielplan"${team.matches.length > 3 ? kPlan.attr : ''}><h2>Spielplan${bilanz.length > 0 ? ` <span class="muted small" style="font-family:'Barlow',sans-serif;text-transform:none;font-weight:500">${bilanz.length} von ${team.matches.length} gespielt</span>` : ''}</h2>
  <div class="filter" data-filter-bar role="group" aria-label="Spielplan filtern" hidden>
    <span class="ansicht" role="group" aria-label="Ansicht">${[['liste', 'Liste'], ['kalender', 'Kalender']].map(([k, l]) => `<button type="button" data-ansicht="${k}" aria-pressed="${k === 'liste'}">${l}</button>`).join('')}</span>
    ${[['alle', 'Alle'], ['heim', 'Heim'], ['aus', 'Auswärts'], ['kommend', 'Kommend'], ['gespielt', 'Gespielt']].map(([k, l]) => `<button type="button" class="liste-nur" data-filter="${k}" aria-pressed="${k === 'alle'}">${l}</button>`).join('')}
    ${naechstesId ? '<button type="button" data-jump class="jump liste-nur">Zum nächsten Spiel ↓</button>' : ''}
  </div>
  <ul class="plan">${items}</ul>
  ${kalenderHtml(team, now)}</section>`;
}

const MONAT = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * Der Spielplan als Monatskalender — alle Monate mit einem Spiel, das Skript
 * zeigt einen davon und blättert. Heim und Auswärts stehen als Buchstabe vor
 * Uhrzeit oder Ergebnis, damit die Farbe nichts allein trägt. Ohne Skript
 * bleibt der Kalender unsichtbar (die Liste ist der Spielplan).
 */
function kalenderHtml(team: HandballTeamView, now: Date): string {
  const nachTag = new Map<string, HandballMatchView[]>();
  for (const m of team.matches) {
    if (m.status === 'cancelled') continue;
    const tag = TAG_ISO.format(new Date(m.starts_at));
    nachTag.set(tag, [...(nachTag.get(tag) ?? []), m]);
  }
  if (nachTag.size === 0) return '';
  const tage = [...nachTag.keys()].sort();
  const monate: string[] = [];
  for (let [j, mo] = tage[0]!.split('-').map(Number) as [number, number]; `${j}-${String(mo).padStart(2, '0')}` <= tage[tage.length - 1]!.slice(0, 7); mo === 12 ? (j++, mo = 1) : mo++) {
    monate.push(`${j}-${String(mo).padStart(2, '0')}`);
  }
  const heute = TAG_ISO.format(now);
  const aktuell = (team.next_match ? TAG_ISO.format(new Date(team.next_match.starts_at)) : tage[tage.length - 1]!).slice(0, 7);
  const html = monate.map(mon => {
    const [j, mo] = mon.split('-').map(Number) as [number, number];
    const erster = new Date(Date.UTC(j, mo - 1, 1));
    const versatz = (erster.getUTCDay() + 6) % 7;
    const anzahl = new Date(Date.UTC(j, mo, 0)).getUTCDate();
    const zellen: string[] = Array.from({ length: versatz }, () => '<div class="tag leer" aria-hidden="true"></div>');
    for (let t = 1; t <= anzahl; t++) {
      const iso = `${mon}-${String(t).padStart(2, '0')}`;
      const spiele = nachTag.get(iso) ?? [];
      const chips = spiele.map(m => {
        const mitStand = m.score_home !== null && m.score_away !== null && (m.status === 'finished' || m.rated);
        const inhalt = `${m.is_home ? 'H' : 'A'} ${mitStand ? `${standHeimGast(m)}` : ZEIT.format(new Date(m.starts_at))}`;
        const klasse = `chip ${m.is_home ? 'heim' : 'aus'} ${mitStand ? (m.won === true ? 'w' : m.won === false ? 'l' : '') : ''}`.trim();
        const label = `${DATUM_KURZ.format(new Date(m.starts_at))}, ${m.is_home ? 'Heimspiel gegen' : 'Auswärtsspiel bei'} ${gegnerVon(m)}${mitStand ? `, ${standHeimGast(m)}` : `, ${ZEIT.format(new Date(m.starts_at))} Uhr`}`;
        return mitStand
          ? `<a class="${klasse}" href="${h(`./spiel/${encodeURIComponent(m.match_id)}`)}" title="${h(label)}" aria-label="${h(label)}">${h(inhalt)}</a>`
          : `<span class="${klasse}" title="${h(label)}" aria-label="${h(label)}" role="img">${h(inhalt)}</span>`;
      }).join('');
      zellen.push(`<div class="tag${iso === heute ? ' heute' : ''}${spiele.length > 0 ? ' mit' : ''}"><span class="n">${t}</span>${chips}</div>`);
    }
    return `<div class="monat" data-monat="${mon}"${mon === aktuell ? ' data-aktuell' : ''} hidden>
      <div class="monatskopf"><button type="button" data-monat-zurueck aria-label="Vorheriger Monat">‹</button><b>${h(MONAT.format(erster))}</b><button type="button" data-monat-weiter aria-label="Nächster Monat">›</button></div>
      <div class="raster" role="group" aria-label="${h(MONAT.format(erster))}">${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map(w => `<div class="wt" aria-hidden="true">${w}</div>`).join('')}${zellen.join('')}</div>
    </div>`;
  }).join('');
  return `<div class="kal" data-kalender>${html}</div>`;
}

/**
 * Die Saison unter der Tabelle: Tabellenplatz je Spieltag, Bilanz in Zeilen
 * und die Saisonkarte — zugeklappt als „Saisonverlauf".
 */
function saisonTeilHtml(team: HandballTeamView): string {
  const zeilen = alsKlartext(textSaison(team)).slice(1);
  const hatVerlauf = bildVerlauf(team) !== null;
  const karte = bildSaison(team) !== null;
  if (zeilen.length === 0 && !hatVerlauf && !karte) return '';
  return `<details class="more season" id="saison"><summary>Saisonverlauf</summary>
  <div class="body">
  ${hatVerlauf ? `<img class="bild" src="./bild/verlauf.png" alt="Tabellenplatz je Spieltag" loading="lazy" width="800">` : ''}
  ${zeilen.length > 0 ? `<ul class="lines">${zeilen.map(z => `<li>${h(z)}</li>`).join('')}</ul>` : ''}
  </div>
  ${karte ? `<img class="bild" src="./bild/saison.png" alt="Saisonkarte" loading="lazy" width="800" height="450" style="margin-top:14px">` : ''}
</details>`;
}

/** Die Saison als eigener Abschnitt — nur, wenn es (noch) keine Tabelle gibt, unter die sie gehört. */
function saisonHtml(team: HandballTeamView): string {
  const zeilen = alsKlartext(textSaison(team)).slice(1);
  const hatVerlauf = bildVerlauf(team) !== null;
  if (zeilen.length === 0 && !hatVerlauf) return '';
  const k = klappe('saison', zeilen[0] ?? 'Tabellenplatz je Spieltag');
  return `<section class="card season s-season" id="saison"${k.attr}>
  <h2>Saison</h2>
  ${k.zeile}
  <div class="body">
  ${hatVerlauf ? `<img class="bild" src="./bild/verlauf.png" alt="Tabellenplatz je Spieltag" loading="lazy" width="800">` : ''}
  ${zeilen.length > 0 ? `<ul class="lines">${zeilen.map(z => `<li>${h(z)}</li>`).join('')}</ul>` : ''}
  </div>
  ${bildSaison(team) ? `<img class="bild" src="./bild/saison.png" alt="Saisonkarte" loading="lazy" width="800" height="450" style="margin-top:14px">` : ''}
</section>`;
}

// Nicht `--p`: die Vereinsfarbe ist dunkel und verschwindet auf der dunklen Karte.
const TOR_FARBEN = ['var(--ad)', '#e0891a', '#8a63d2', '#c9403a', '#1f9d55'];

/**
 * Die Tore der besten Torschützen über die Saison — je Spieler eine
 * Linie mit der Summe nach jedem gespielten Spiel (die Legende nennt die
 * Namen); null unter zwei Spielen oder ohne Tore.
 */
export function torverlaufHtml(team: HandballTeamView): string | null {
  const top = playerStats(team.team_id).filter(p => p.goals > 0).slice(0, 5);
  const spiele = gespielt(team);
  if (top.length === 0 || spiele.length < 2) return null;
  const reihen = top.map(p => {
    const je = new Map(playerMatchLog(team.team_id, p.playerId).map(l => [l.matchId, l.goals]));
    let summe = 0;
    return { p, werte: spiele.map(m => (summe += je.get(m.match_id) ?? 0)) };
  });
  const maximum = Math.max(...reihen.map(r => r.werte[r.werte.length - 1]), 1);
  const W = 600, H = 180, L = 30, R = 14, T = 12, B = 24;
  const x = (i: number) => L + (i / (spiele.length - 1)) * (W - L - R);
  const y = (v: number) => T + ((maximum - v) / maximum) * (H - T - B);
  const linien = reihen.map((r, i) => `<path d="${r.werte.map((v, k) => `${k === 0 ? 'M' : 'L'} ${x(k).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="${TOR_FARBEN[i]}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
  const achse = [0, Math.round(maximum / 2), maximum].map(v => `<line x1="${L}" y1="${y(v).toFixed(1)}" x2="${W - R}" y2="${y(v).toFixed(1)}" stroke="var(--line)"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${v}</text>`).join('');
  const marken = spiele.map((_, i) => (i === 0 || i === spiele.length - 1 || (i + 1) % 5 === 0)
    ? `<text x="${x(i).toFixed(1)}" y="${H - 7}" text-anchor="middle" font-size="11" fill="var(--muted)">${i + 1}</text>` : '').join('');
  const legende = reihen.map((r, i) => `<li><i style="background:${TOR_FARBEN[i]}"></i>${h(r.p.name)} <b>${r.p.goals}</b></li>`).join('');
  return `<div class="verlauf"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tore der besten Torschützen je Spiel, aufsummiert">${achse}${linien}${marken}</svg></div>
  <ul class="legende">${legende}</ul>
  <p class="muted small" style="margin:4px 0 0">Summe der Tore nach dem n-ten Spiel</p>`;
}

/**
 * Ob ein Foto der Vereinsseite gezeigt werden darf — `gruppe` oder die
 * Kontakt-ID eines Porträts. In der Vorschau: alles, was der Abruf vorhält —
 * Jugendbilder holt er ohnehin nur mit Freigabe (`clubdeskHolen`).
 * Öffentlich: nur, was die Einstellungsseite je Mannschaft freigegeben hat
 * (`SITE_PHOTOS`) — auch bei der Jugend.
 */
export function fotoFreigegeben(team: HandballTeamView, wer: string, vorschau: boolean): boolean {
  const portraet = wer !== 'gruppe';
  if (portraet && !portraits(team.team_id).some(p => p.contactId === wer)) return false;
  if (vorschau) return true;
  const frei = sitePhotos().get(team.team_id);
  return !!frei && (portraet ? frei.spieler : frei.gruppe);
}

/**
 * „Team": wer spielt — Gruppenbild, Kadergrafik und
 * die Porträts der Vereinsseite. Fotos in der Vorschau alle, öffentlich nach
 * Freigabe. Leer, wenn nichts davon da ist.
 */
function teamHtml(team: HandballTeamView, anhang: string, vorschau: boolean): string {
  const gruppe = hatGruppenbild(team.team_id) && fotoFreigegeben(team, 'gruppe', vorschau);
  const personen = portraits(team.team_id).filter(p => fotoFreigegeben(team, p.contactId, vorschau));
  const kader = bildKader(team) !== null;
  if (!gruppe && !kader && personen.length === 0) return '';
  const abschnitte = new Map<string, typeof personen>();
  for (const p of personen) abschnitte.set(p.section, [...(abschnitte.get(p.section) ?? []), p]);
  const teile = [gruppe ? 'Mannschaftsfoto' : '', kader ? 'Kader' : '', personen.length > 0 ? `${personen.length} Porträt${personen.length === 1 ? '' : 's'}` : ''].filter(Boolean);
  const k = klappe('team', teile.length > 1 ? `${teile.slice(0, -1).join(', ')} und ${teile[teile.length - 1]}` : teile[0]!);
  const fotos = gruppe || personen.length > 0;
  return `<section class="card s-team" id="team"${k.attr}>
  <h2>Team${vorschau && fotos ? ' <span class="badge">Vorschau</span>' : ''}</h2>
  ${k.zeile}
  ${gruppe ? `<img class="bild" src="./foto/gruppe.jpg${h(anhang)}" alt="${h(`Gruppenbild ${vereinsName(team.name)} ${team.label}`)}" loading="lazy" width="1600">` : ''}
  ${kader ? `<img class="bild" src="./bild/kader.png" alt="Kader" loading="lazy" width="800" height="450"${gruppe ? ' style="margin-top:14px"' : ''}>` : ''}
  ${[...abschnitte].map(([titel, leute]) => `<h3 class="unter">${h(titel)}</h3>
  <ul class="portraets">${leute.map(p => `<li><img src="./foto/${h(p.contactId)}.jpg${h(anhang)}" alt="" loading="lazy" width="400" height="500"><b>${h(p.name)}</b>${p.position ? `<span>${h(p.position)}</span>` : ''}</li>`).join('')}</ul>`).join('')}
  ${fotos ? '<p class="muted small" style="margin:10px 0 0">Fotos: Vereinsseite der Wölfe Voreifel (ClubDesk).</p>' : ''}
</section>`;
}

/** „Statistiken": Torverlauf und Torjäger der Saison. */
function statistikenHtml(team: HandballTeamView): string {
  const stats = playerStats(team.team_id);
  const bester = stats.filter(p => p.goals > 0)[0];
  if (!bester) return '';
  const verlauf = torverlaufHtml(team);
  const k = klappe('statistiken', `${stats.length} Spieler · Torjäger ${bester.name} mit ${bester.goals} Toren`);
  return `<section class="card s-stats" id="statistiken"${k.attr}>
  <h2>Statistiken</h2>
  ${k.zeile}
  ${verlauf ? `<h3 class="unter">Tore im Saisonverlauf</h3>${verlauf}` : ''}
  <img class="bild" src="./bild/torjaeger.png" alt="Torschützen der Saison" loading="lazy" width="800">
</section>`;
}

/**
 * „Team-Infos nicht verpassen" (Startseite: „Alle Infos nicht verpassen"): die Wege im Kopf der Mannschaftsseite, rechtsbündig als
 * Icons mit der kleinen Überschrift darüber — Browser-Push (öffnet ein Fenster
 * mit dem Formular), Telegram-Bot (wenn er registriert ist), Kalender-Abo und
 * Feed (Adresse kopieren). Das Fenster steht für sich am Ende der Seite
 * (`<dialog>` liegt in der obersten Ebene und wird vom Kopf nicht beschnitten).
 */
function verpassenHtml(baseUrl: string, pushEnabled: boolean, telegram: { link: string; handle: string } | null, club = false, team: { id: string; label: string } | null = null): { leiste: string; dialog: string } {
  const webcal = baseUrl.replace(/^https?:\/\//, 'webcal://') + 'kalender.ics';
  const appName = club ? SITE_TITEL : team?.label ?? '';
  const installTitel = `${appName} als App installieren`;
  const leiste = `<div class="verpassen" role="group" aria-labelledby="verpassen-titel">
    <span class="titel" id="verpassen-titel">${club ? 'Alle Infos nicht verpassen' : 'Team-Infos nicht verpassen'}</span>
    <span class="icons">
      <button type="button" class="vicon" data-dialog-open="push" title="Benachrichtigungen im Browser" aria-label="Benachrichtigungen im Browser" hidden>${ICON.bell}<span class="punkt" data-aktiv hidden></span></button>
      ${telegram ? `<a class="vicon tg" href="${h(telegram.link)}" target="_blank" rel="noopener noreferrer" title="Telegram-Bot ${h(telegram.handle)}" aria-label="Telegram-Bot ${h(telegram.handle)}">${ICON.send}</a>` : ''}
      ${club ? '' : `<a class="vicon" href="${h(webcal)}" title="Kalender abonnieren" aria-label="Kalender abonnieren">${ICON.calendar}</a>
      <button type="button" class="vicon rss" data-copy="${h(baseUrl + 'feed.xml')}" title="RSS-Feed-Adresse kopieren" aria-label="RSS-Feed-Adresse kopieren">${ICON.rss}</button>`}
      <a class="vicon" href="./?installieren=1" target="_blank" rel="noopener" data-install title="${h(installTitel)}" aria-label="${h(installTitel)}" hidden>${ICON.app}</a>
    </span>
  </div>`;
  const dialog = `<dialog class="popup" id="push" data-push="${pushEnabled ? '1' : '0'}" data-scope="${club ? 'club' : 'team'}" data-team="${h(team?.id ?? '*')}" data-label="${h(club ? 'Alle Heimspiele' : team?.label ?? '')}" aria-labelledby="push-titel">
  <h2 id="push-titel">${club ? 'Alle Heimspiele im Browser' : 'Benachrichtigungen im Browser'}</h2>
  <p class="lead">${club ? 'Eine Anmeldung, ohne eine Mannschaft zu wählen.' : 'Dieses Gerät sagt Bescheid, wenn ein Spiel ansteht und wie es ausgegangen ist.'} Wähle, was ankommen soll.</p>
  <p class="geltung" data-geltung>${club
    ? '<b>Gilt für:</b> alle Heimspiele aller Mannschaften des Vereins. Zusätzlich kannst du auf der Seite einer Mannschaft deren Auswärtsspiele abonnieren, beides geht gleichzeitig.'
    : '<b>Gilt für:</b> Heim- und Auswärtsspiele dieser Mannschaft. Alle Heimspiele des Vereins gibt es zusätzlich über die Glocke auf der <a href="../">Startseite</a>, beides geht gleichzeitig.'}</p>
  <p class="geltung" data-andere hidden></p>
  <p class="status" data-status role="status" aria-live="polite">${pushEnabled ? 'Einen Moment …' : 'Benachrichtigungen sind auf diesem Server nicht eingerichtet — Kalender und Feed gehen trotzdem.'}</p>
  <form data-form hidden>
    <fieldset class="themen">
      <legend>Was soll ankommen?</legend>
      <label class="thema"><input type="checkbox" name="thema" value="upcoming" checked>
        <span><b>Ankündigung</b><small>„Heute 18:00 Uhr: ${club ? 'Wölfe' : 'Spiel'} gegen …“ mit Halle und Gegner</small></span></label>
      <div class="opts einzug" data-lead>
        <label><input type="radio" name="lead" value="1h" checked> 1 Stunde vorher</label>
        <label><input type="radio" name="lead" value="3h"> 3 Stunden vorher</label>
        <label><input type="radio" name="lead" value="abend"> Am Vorabend, 19 Uhr</label>
      </div>
      <label class="thema"><input type="checkbox" name="thema" value="halftime" checked>
        <span><b>Halbzeitstand</b><small>„Halbzeit: 14:12“, sobald er vorliegt</small></span></label>
      <label class="thema"><input type="checkbox" name="thema" value="result" checked>
        <span><b>Endstand</b><small>„Endstand 28:24 — Sieg!“ mit Ergebniskarte und neuem Tabellenplatz</small></span></label>
      <label class="thema"><input type="checkbox" name="thema" value="change" checked>
        <span><b>Verlegungen und Absagen</b><small>„Spiel verlegt auf Sa 16:00 Uhr“</small></span></label>
      ${club ? `<label class="thema"><input type="checkbox" name="thema" value="preview" checked>
        <span><b>Wochenvorschau</b><small>Donnerstagabend: „Dieses Wochenende: 4 Heimspiele“ (ohne Halle, die steht auf der Startseite)</small></span></label>` : ''}
    </fieldset>
    <p class="muted small" data-zusammen aria-live="polite"></p>
    <p class="muted small">Nicht dabei: Aufstellungen, Spielernamen und Spielberichte.</p>
    <div class="row">
      <button class="btn primary" type="submit" data-subscribe>Benachrichtigungen einschalten</button>
      <button class="btn ghost" type="button" data-unsubscribe hidden>Ausschalten</button>
    </div>
  </form>
  <p class="muted small" data-ios hidden>iPhone und iPad: Safari erlaubt Benachrichtigungen nur für Seiten auf dem Home-Bildschirm. Erst „Teilen → Zum Home-Bildschirm", dann von dort öffnen und hier einschalten.</p>
  <form method="dialog" class="schliessen"><button class="btn ghost" type="submit">Schließen</button></form>
</dialog>
<dialog class="popup" id="installieren" aria-labelledby="installieren-titel">
  <h2 id="installieren-titel">${h(installTitel)}</h2>
  <p class="lead">${h(`„${appName}“`)} liegt dann wie eine App auf dem Startbildschirm: ein Tipp, und ${club ? 'alle Mannschaften sind' : 'Spielplan, Ergebnisse und Tabelle dieser Mannschaft sind'} da, in der vollen Ansicht und ohne Netz mit dem zuletzt geladenen Stand.</p>
  <div class="row" data-install-prompt hidden><button class="btn primary" type="button" data-install-go>Jetzt installieren</button></div>
  <div data-install-ios hidden>
    <ol>
      <li>In Safari auf „Teilen“ tippen (das Viereck mit dem Pfeil nach oben).</li>
      <li>„Zum Home-Bildschirm“ wählen.</li>
      <li>Mit „Hinzufügen“ bestätigen.</li>
    </ol>
    <p class="muted small">Aus WhatsApp, Instagram oder einer anderen App geöffnet? Erst „In Safari öffnen“ wählen.</p>
  </div>
  <p data-install-menu hidden>Im Menü des Browsers (⋮) „App installieren“ oder „Zum Startbildschirm hinzufügen“ wählen. Am Telefon geht das mit Chrome, Samsung Internet und Safari.</p>
  <p data-install-done hidden>Die App ist auf diesem Gerät schon installiert.</p>
  <form method="dialog" class="schliessen"><button class="btn ghost" type="submit">Schließen</button></form>
</dialog>`;
  return { leiste, dialog };
}

/**
 * Die ganze Seite als HTML. Liest nur, was `handballOverview()` schon
 * geliefert hat; kein Aufruf nach draußen. Ab 960 px zwei Spalten: links
 * das Spiel (nächstes, letztes, Tabelle mit Saisonverlauf, Team, Statistiken), rechts der
 * Spielplan; die Wege, nichts zu verpassen, sitzen als Icons im Kopf; am Telefon eine Spalte in
 * der Reihenfolge, in der man die Seite liest (`order` je Abschnitt).
 */
export function renderSiteHtml(team: HandballTeamView, opts: SiteRenderOptions): string {
  const now = opts.now ?? new Date();
  // In der Vorschau trägt jeder Verweis innerhalb der Seite den Schlüssel weiter.
  const anhang = opts.vorschau ? `?vorab=${encodeURIComponent(opts.vorschau)}` : '';
  const palette = vervollstaendigePalette(readPalette());
  const logo = logoDataUri(team.team_id);
  const naechstes = team.next_match;
  const letztes = team.last_match;
  const beschreibung = naechstes
    ? `Nächstes Spiel: ${naechstes.is_home ? 'gegen' : 'bei'} ${gegnerVon(naechstes)}, ${DATUM_LANG.format(new Date(naechstes.starts_at))} um ${ZEIT.format(new Date(naechstes.starts_at))} Uhr`
    : letztes && letztes.score_home !== null
      ? `Zuletzt: ${standHeimGast(letztes)} ${letztes.is_home ? 'gegen' : 'bei'} ${gegnerVon(letztes)}`
      : 'Spielplan, Ergebnisse und Tabelle';
  const ogBild = naechstes && !naechstes.is_live
    ? `${opts.baseUrl}bild/spiel.png`
    : letztes && letztes.score_home !== null ? `${opts.baseUrl}bild/endstand.png?match=${encodeURIComponent(letztes.match_id)}` : null;
  const wettbewerb = team.standings[0]?.competition_name ?? aktuellesSpiel(team.matches)?.competition_name ?? '';
  const titel = `${vereinsName(team.name)}${team.championship_name ? ` · ${team.championship_name}` : ''}`;
  const botLink = handballBotLink();
  const botName = getHandballBotUsername();
  const telegram = botLink && botName ? { link: botLink, handle: `@${botName}` } : null;
  const verpassen = verpassenHtml(opts.baseUrl, opts.pushEnabled, telegram, false, { id: team.team_id, label: team.label });
  const abschnitte = {
    naechstes: naechstesSpielHtml(team, now, opts.baseUrl),
    letztes: letztesSpielHtml(team, opts.baseUrl),
    tabelle: tabelleHtml(team, now, saisonTeilHtml(team)),
    saison: '',
    team: teamHtml(team, anhang, !!opts.vorschau),
    statistiken: statistikenHtml(team),
    spielplan: spielplanHtml(team, now),
  };
  // Die Saison steht unter der Tabelle; nur ohne Tabelle (Saisonbeginn, Freundschaftsspiele) für sich.
  if (!abschnitte.tabelle) abschnitte.saison = saisonHtml(team);
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${h(titel)}</title>
<meta name="description" content="${h(beschreibung)}">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="${palette.primary}">
<meta name="color-scheme" content="light dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${h(team.label)}">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta property="og:type" content="website">
<meta property="og:title" content="${h(titel)}">
<meta property="og:description" content="${h(beschreibung)}">
<meta property="og:url" content="${h(opts.baseUrl)}">
${ogBild ? `<meta property="og:image" content="${h(ogBild)}">\n<meta property="og:image:width" content="1600">\n<meta property="og:image:height" content="900">\n<meta name="twitter:card" content="summary_large_image">` : ''}
<link rel="manifest" href="./manifest.webmanifest">
<link rel="icon" href="./logo.png" type="image/png">
<link rel="apple-touch-icon" href="./logo.png">
<link rel="alternate" type="application/rss+xml" title="${h(vereinsName(team.name))} — Ergebnisse" href="./feed.xml">
<script src="./theme.js?v=${inhaltsHash(SITE_THEME_JS)}"></script>
<link rel="stylesheet" href="./site.css?v=${siteCssText().hash}">
</head>
<body${istLiveFenster(naechstes, now) ? ' data-live="1"' : ''}>
<a class="skip" href="#inhalt">Zum Inhalt</a>
${opts.vorschau ? '<div class="vorschau-band" role="note">Vorschau — nur über deinen Vorschau-Link erreichbar. Fotos von der Vereinsseite, Rechte noch nicht geklärt.</div>' : ''}
<div class="offline" data-offline role="status" hidden>Du bist offline — gezeigt wird der zuletzt geladene Stand.</div>
${heroHtml(team, logo, now, opts.teams ?? [], anhang, '../', verpassen.leiste)}
${sprungleisteHtml([
  ['naechstes', naechstes?.is_live ? 'Läuft gerade' : 'Nächstes Spiel', abschnitte.naechstes],
  ['letztes', 'Letztes Spiel', abschnitte.letztes],
  ['tabelle', 'Tabelle', abschnitte.tabelle],
  ['spielplan', 'Spielplan', abschnitte.spielplan],
  ['saison', 'Saison', abschnitte.saison],
  ['team', 'Team', abschnitte.team],
  ['statistiken', 'Statistiken', abschnitte.statistiken],
])}
<main class="wrap" id="inhalt">
<div class="col main">
${abschnitte.naechstes}
${abschnitte.letztes}
${abschnitte.tabelle}
${abschnitte.saison}
${abschnitte.team}
${abschnitte.statistiken}
</div>
<div class="col side">
${abschnitte.spielplan}
</div>
</main>
<footer class="wrap">
  <div>Daten von <a href="https://www.handball.net/team/${encodeURIComponent(team.team_id)}" target="_blank" rel="noopener noreferrer">handball.net</a>${wettbewerb ? ` · ${h(wettbewerb)}` : ''}${opts.stand ? ` · Stand ${h(STAND.format(new Date(opts.stand)))} Uhr` : ''}.
  Spielzeiten in deutscher Ortszeit.</div>
  ${betreiberZeile()}
</footer>
${verpassen.dialog}
<script src="./app.js?v=${inhaltsHash(SITE_APP_JS)}" defer></script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Unterseiten: Spielseite und Übersicht aller Mannschaften
// ---------------------------------------------------------------------------

/**
 * Das gemeinsame Gerüst der Unterseiten. Sie liegen eine Ebene tiefer als die
 * Mannschaftsseite (`/<Team-ID>/spiel/<Spiel>`) oder sind die Startseite; ihre
 * Dateien holen sie deshalb über `dateien` (Stil, Skript und Schrift liegen
 * unter der Mannschaft). Kein Manifest und kein eigener Service Worker — der
 * gehört der Mannschaftsseite.
 */
function unterseiteHtml(o: { dialog?: string; breit?: boolean; ogLogo?: boolean; app?: { titel: string; manifest: string }; live?: boolean; titel: string; beschreibung: string; url: string; ogBild: string | null; dateien: string; kopf: string; inhalt: string; fuss: string }): string {
  const palette = vervollstaendigePalette(readPalette());
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${h(o.titel)}</title>
<meta name="description" content="${h(o.beschreibung)}">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="${palette.primary}">
<meta name="color-scheme" content="light dark">
<meta property="og:type" content="website">
<meta property="og:title" content="${h(o.titel)}">
<meta property="og:description" content="${h(o.beschreibung)}">
<meta property="og:url" content="${h(o.url)}">
${o.ogBild ? (o.ogLogo
    ? `<meta property="og:image" content="${h(o.ogBild)}">\n<meta property="og:image:width" content="512">\n<meta property="og:image:height" content="512">\n<meta name="twitter:card" content="summary">`
    : `<meta property="og:image" content="${h(o.ogBild)}">\n<meta property="og:image:width" content="1600">\n<meta property="og:image:height" content="900">\n<meta name="twitter:card" content="summary_large_image">`) : ''}
<link rel="icon" href="${o.dateien}logo.png" type="image/png">
${o.app ? `<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-title" content="${h(o.app.titel)}">\n<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n<link rel="manifest" href="${h(o.app.manifest)}">\n<link rel="apple-touch-icon" href="${o.dateien}logo.png">` : ''}
<script src="${o.dateien}theme.js?v=${inhaltsHash(SITE_THEME_JS)}"></script>
<link rel="stylesheet" href="${o.dateien}site.css?v=${siteCssText().hash}">
</head>
<body${o.live ? ' data-live="1"' : ''}>
<a class="skip" href="#inhalt">Zum Inhalt</a>
<div class="offline" data-offline role="status" hidden>Du bist offline — gezeigt wird der zuletzt geladene Stand.</div>
${o.kopf}
<main class="wrap${o.breit ? ' breit' : ' schmal'}" id="inhalt">
${o.inhalt}
</main>
<footer class="wrap">
  ${o.fuss}
  ${betreiberZeile()}
</footer>
${o.dialog ?? ''}
<script src="${o.dateien}app.js?v=${inhaltsHash(SITE_APP_JS)}" defer></script>
</body>
</html>
`;
}

/**
 * Die Sprungleiste unter dem Kopf: je vorhandenem Abschnitt ein Chip mit
 * Anker. Ohne Skript sind es gewöhnliche Sprungmarken; mit Skript klebt sie
 * oben und markiert den Abschnitt, in dem man gerade liest.
 */
function sprungleisteHtml(ziele: Array<[string, string, string]>): string {
  const da = ziele.filter(([, , html]) => html.trim() !== '');
  if (da.length < 2) return '';
  return `<nav class="sprung" aria-label="Abschnitte" data-sprung><div class="wrap"><ul>${da.map(([id, label]) => `<li><a href="#${id}">${h(label)}</a></li>`).join('')}</ul></div></nav>`;
}

/**
 * Ein Abschnitt, der mit Skript zunächst eingeklappt steht: das Attribut für
 * die Section und die eine Zeile, die im eingeklappten Zustand bleibt. Ohne
 * Skript ist alles offen und die Zeile versteckt.
 */
function klappe(schluessel: string, vorschau: string): { attr: string; zeile: string } {
  return { attr: ` data-klappe="${h(schluessel)}"`, zeile: `<p class="vorschau" hidden>${h(vorschau)}</p>` };
}

function initialenVon(name: string): string {
  return name.split(/\s+/).filter(w => /^[A-ZÄÖÜ]/.test(w)).map(w => w[0]).join('').slice(0, 3) || 'HB';
}

/** Die Mannschaftswahl für Unterseiten, die eine Ebene tiefer liegen als die Mannschaftsseite. */
function teamsEineEbeneTiefer(teams: SiteTeamLink[]): SiteTeamLink[] {
  return teams.map(t => ({ ...t, url: `../${t.url}` }));
}

/**
 * Die Spielseite: ein einzelnes Spiel mit allem, was die Seite dazu weiß —
 * Spielstand und Halbzeit, Endstandbild, Spielverlauf mit Torfolge, Halle samt
 * Route und die Torschützen. Der Spielbericht der Quelle steht
 * nicht auf der Seite, nur der Verweis auf den Bogen (PDF). Null, wenn die
 * Mannschaft dieses Spiel nicht hat.
 */
export function renderSpielHtml(team: HandballTeamView, matchId: string, opts: SiteRenderOptions): string | null {
  const m = team.matches.find(x => x.match_id === matchId);
  if (!m) return null;
  const now = opts.now ?? new Date();
  const start = new Date(m.starts_at);
  const fertig = (m.status === 'finished' || m.rated) && m.score_home !== null && m.score_away !== null;
  const halle = [m.venue_name, m.venue_address].filter(Boolean).join(', ');
  const routen = routenLinks(m);
  const wettbewerb = `${m.competition_name}${m.round ? `, ${m.round}. Spieltag` : ''}`;
  const status = statusWort(m);
  const ausgang = !fertig ? null : m.won === true ? 'Sieg' : m.won === false ? 'Niederlage' : 'Unentschieden';
  const hz = fertig && m.halftime_home !== null && m.halftime_away !== null ? `Halbzeit ${m.halftime_home}:${m.halftime_away}` : null;
  const paarung = `${m.home_name} gegen ${m.away_name}`;
  const stand = fertig ? `${m.score_home}:${m.score_away}` : null;
  const titel = `${stand ? `${m.home_name} ${stand} ${m.away_name}` : paarung} · ${vereinsName(team.name)}`;
  const beschreibung = `${DATUM_LANG.format(start)}, ${ZEIT.format(start)} Uhr · ${wettbewerb}${ausgang ? ` · ${ausgang}` : ''}`;
  const logo = logoDataUri(team.team_id);
  const verlauf = fertig ? spielverlaufSvg(m) : null;
  const schuetzen = fertig ? playerGames(team.team_id).filter(g => g.matchId === m.match_id && g.goals > 0) : [];
  const bild = fertig ? `../bild/endstand.png?match=${encodeURIComponent(m.match_id)}` : null;
  const kopf = heroHtml(team, logo, now, teamsEineEbeneTiefer(opts.teams ?? []), '', '../../');
  const inhalt = `<p><a class="zurueck" href="../">← Zur Mannschaftsseite</a></p>
<section class="card" id="spiel">
  <h2>${fertig ? 'Endstand' : m.is_live ? 'Läuft gerade' : 'Spiel'}${status && !fertig ? ` <span class="badge">${h(status)}</span>` : ''}</h2>
  <div class="spielstand" aria-label="${fertig ? 'Endstand' : 'Paarung'}">
    <span class="seite">${h(m.home_name)}</span>
    <b class="tore-gross">${stand ?? 'vs.'}</b>
    <span class="seite">${h(m.away_name)}</span>
  </div>
  <div class="info">
    <span>${h(DATUM_LANG.format(start))}, ${h(ZEIT.format(start))} Uhr · ${m.is_home ? 'Heimspiel' : 'Auswärts'}</span>
    <span class="muted small">${h(wettbewerb)}${ausgang ? ` · ${ausgang}${m.rated ? ' (gewertet)' : ''}` : ''}${hz ? ` · ${hz}` : ''}</span>
    ${halle ? `<span>📍 ${h(halle)}</span>` : ''}
  </div>
  ${bild ? `<img class="bild" style="margin-top:14px" src="${h(bild)}" width="800" height="450" alt="${h(`Endstand ${m.home_name} ${m.score_home}:${m.score_away} ${m.away_name}`)}" loading="lazy">` : ''}
  <div class="row" style="margin-top:14px">
    ${teilenHtml({ url: `${opts.baseUrl}spiel/${encodeURIComponent(m.match_id)}`, titel, text: stand ? `Endstand: ${m.home_name} ${stand} ${m.away_name}` : `${paarung} · ${DATUM_LANG.format(start)}, ${ZEIT.format(start)} Uhr`, bild })}
    ${routen.map(r => `<a class="btn" href="${h(r.href)}" target="_blank" rel="noopener noreferrer">🧭 ${h(r.label)}</a>`).join('')}
    ${m.report_url ? `<a class="btn" href="${h(m.report_url)}" target="_blank" rel="noopener noreferrer">Spielberichtsbogen (PDF)</a>` : ''}
    <a class="btn" href="${h(m.url)}" target="_blank" rel="noopener noreferrer">Auf handball.net</a>
  </div>
</section>
${verlauf ? `<section class="card" id="verlauf">
  <h2>Spielverlauf</h2>
  <div class="verlauf">${verlauf}</div>${torfolgeText(m)}
</section>` : ''}
${schuetzen.length > 0 ? `<section class="card" id="schuetzen">
  <h2>Torschützen</h2>
  <ul class="schuetzen">${schuetzen.map(g => `<li><span>${h(g.name)}</span><b>${g.goals} Tor${g.goals === 1 ? '' : 'e'}${g.sevenMeterGoals > 0 ? ` <span class="muted small">(${g.sevenMeterGoals}× 7m)</span>` : ''}</b></li>`).join('')}</ul>
</section>` : ''}`;
  const fuss = `<div>Daten von <a href="https://www.handball.net/team/${encodeURIComponent(team.team_id)}" target="_blank" rel="noopener noreferrer">handball.net</a>${opts.stand ? ` · Stand ${h(STAND.format(new Date(opts.stand)))} Uhr` : ''}. Spielzeiten in deutscher Ortszeit.</div>`;
  return unterseiteHtml({
    titel, beschreibung, url: `${opts.baseUrl}spiel/${encodeURIComponent(m.match_id)}`,
    ogBild: bild ? `${opts.baseUrl}bild/endstand.png?match=${encodeURIComponent(m.match_id)}` : null,
    dateien: '../', kopf, inhalt, fuss,
  });
}

/**
 * Freitag, Samstag und Sonntag des Wochenendes, das ansteht — als Berliner
 * Kalendertage `JJJJ-MM-TT`. Von Montag bis Freitag ist es das kommende; an
 * einem Samstag oder Sonntag das laufende, damit die Spiele von heute nicht
 * verschwinden. Der Freitag zählt dazu, weil auch dann Heimspiele sind.
 */
export function naechstesWochenende(now: Date): { fr: string; sa: string; so: string } {
  const [j, m, t] = TAG_ISO.format(now).split('-').map(Number);
  const heute = new Date(Date.UTC(j, m - 1, t));
  const wt = heute.getUTCDay(); // 0 = Sonntag
  const sa = new Date(heute.getTime() + (wt === 0 ? -1 : 6 - wt) * 86400000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { fr: iso(new Date(sa.getTime() - 86400000)), sa: iso(sa), so: iso(new Date(sa.getTime() + 86400000)) };
}

type Wochenende = { fr: string; sa: string; so: string };

/** Das Wochenende (Fr–So), auf dem ein Spiel liegt — null unter der Woche. */
function wochenendeVon(m: HandballMatchView): Wochenende | null {
  const tag = TAG_ISO.format(new Date(m.starts_at));
  const we = naechstesWochenende(new Date(`${tag}T12:00:00Z`));
  return [we.fr, we.sa, we.so].includes(tag) ? we : null;
}

function findetStatt(m: HandballMatchView): boolean {
  return m.status !== 'cancelled' && m.status !== 'postponed';
}

/**
 * Der Spieltag, den die Startseite zeigt: das kommende Wochenende — oder,
 * wenn dort keine Mannschaft spielt (Ferien), das nächste Wochenende mit
 * einem angesetzten Spiel. Ohne ein solches bleibt es beim kommenden.
 */
export function spielWochenende(matches: HandballMatchView[], now: Date): Wochenende {
  const we = naechstesWochenende(now);
  const tage = [we.fr, we.sa, we.so];
  if (matches.some(m => findetStatt(m) && tage.includes(TAG_ISO.format(new Date(m.starts_at))))) return we;
  const naechstes = matches
    .filter(m => m.status === 'scheduled' && TAG_ISO.format(new Date(m.starts_at)) > we.so && wochenendeVon(m) !== null)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
  return naechstes ? wochenendeVon(naechstes)! : we;
}

/**
 * Das Wochenende für „Ergebnisse": das letzte vor `vor` mit einem gewerteten
 * Spiel — nach den Ferien also das letzte gespielte, nicht ein leeres. Ohne
 * Ergebnis das Wochenende eine Woche vor `vor`.
 */
export function letztesSpielWochenende(matches: HandballMatchView[], vor: Wochenende): Wochenende {
  const letztes = matches
    .filter(m => (m.status === 'finished' || m.rated) && m.score_home !== null && m.score_away !== null
      && TAG_ISO.format(new Date(m.starts_at)) < vor.fr && wochenendeVon(m) !== null)
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at))[0];
  return letztes ? wochenendeVon(letztes)! : { fr: verschiebeTag(vor.fr, -7), sa: verschiebeTag(vor.sa, -7), so: verschiebeTag(vor.so, -7) };
}

/** Wie lange vor dem Anwurf sich die Seite schon selbst aktualisiert, damit sie beim Anpfiff von allein auf Live springt. */
const LIVE_VORLAUF_MS = 20 * 60 * 1000;

/** Läuft das Spiel oder beginnt es in den nächsten 20 Minuten? Dann darf die Seite nur kurz im Zwischenspeicher liegen. */
export function istLiveFenster(m: HandballMatchView | null | undefined, now = new Date()): boolean {
  if (!m) return false;
  if (m.is_live) return true;
  const bis = Date.parse(m.starts_at) - now.getTime();
  return m.status === 'scheduled' && bis > 0 && bis <= LIVE_VORLAUF_MS;
}

/** Einen ISO-Tag (JJJJ-MM-TT) um n Tage verschieben. */
function verschiebeTag(iso: string, n: number): string {
  const [j, m, t] = iso.split('-').map(Number);
  return new Date(Date.UTC(j!, m! - 1, t! + n)).toISOString().slice(0, 10);
}

function tagMonat(iso: string): string {
  const [, m, t] = iso.split('-');
  return `${t}.${m}.`;
}

/** Die Reihenfolge „Herren, Damen, Jugend" für die Sortierung der Heimspiele; Weitere zuletzt. */
const GRUPPEN_RANG: Record<string, number> = { herren: 0, frauen: 1, jungen: 2, maedchen: 3, kinder: 4 };
const GRUPPEN_KURZ: Record<string, string> = { herren: 'Herren', frauen: 'Damen', jungen: 'Jugend m', maedchen: 'Jugend w', kinder: 'Kinder' };

/**
 * Die Startseite (`/`), „Wölfe live - Handball im Revier": der Überblick über alle
 * Mannschaften des Vereins. Oben die fünf Bereiche mit ihren Mannschaften zum
 * Aufklappen; dann, was läuft; dann die Heimspiele des Wochenendes (Fr–So) in
 * einer Tabelle, die sich per Chip nach Datum, Spielort oder Bereich sortieren
 * lässt — mit Halle, Adresse und Routenlink, damit man sieht, wo gespielt
 * wird; darunter jede Mannschaft mit Tabellenplatz, nächstem und letztem
 * Spiel. Liest nur, was die Übersicht schon hat.
 */
export function renderStartHtml(teams: HandballTeamView[], opts: { teams: SiteTeamLink[]; baseUrl: string; stand: string | null; now?: Date; pushEnabled?: boolean }): string {
  const now = opts.now ?? new Date();
  const erste = teams[0];
  const link = (t: HandballTeamView, anker = '') => `./${encodeURIComponent(t.team_id)}/${anker}`;
  const alle = teams.flatMap(t => t.matches.map(m => ({ t, m })));
  const live = alle.filter(x => x.m.is_live);

  const kommendes = naechstesWochenende(now);
  const we = spielWochenende(alle.map(x => x.m), now);
  const tage = [we.fr, we.sa, we.so];
  const heute = TAG_ISO.format(now);
  const laeuft = tage.includes(heute);
  const spaeter = we.fr !== kommendes.fr;
  const heimspiele = alle
    .filter(x => x.m.is_home && x.m.status !== 'cancelled' && x.m.status !== 'postponed'
      && tage.includes(TAG_ISO.format(new Date(x.m.starts_at))))
    .sort((a, b) => a.m.starts_at.localeCompare(b.m.starts_at));

  const liveHtml = live.length > 0 ? `<section class="card dark live" id="live">
  <h2>Läuft gerade <span class="badge live">Live</span></h2>
  <ul class="plan">${live.map(({ t, m }) => {
    const stand = m.live && m.live.home !== null && m.live.away !== null ? `${m.live.home}:${m.live.away}` : standHeimGast(m) ?? '–:–';
    return `<li>
      <span class="d">${h(ZEIT.format(new Date(m.starts_at)))} Uhr</span>
      <span class="g"><a class="titel" href="${h(link(t, '#naechstes'))}">${h(t.label)}</a><div class="ha">${m.is_home ? 'gegen' : 'bei'} ${h(gegnerVon(m))}${m.venue_name ? ` · ${h(m.venue_name)}` : ''}</div><button type="button" class="stumm" data-stumm="${h(t.team_id)}" aria-pressed="false" hidden>🔔 Tore melden</button></span>
      <span class="e" data-key="${h(t.team_id)}" data-label="${h(t.label)}" data-heim="${m.is_home ? '1' : '0'}" data-stand="${/^\d+:\d+$/.test(stand) ? stand : ''}">${stand}</span>
    </li>`;
  }).join('')}</ul>
  <div class="row livesteuerung" style="margin-top:12px">${VIBRATION_KNOPF}<span class="muted small" data-stumm-hinweis hidden>Mit „Tore melden“ wählst du, bei welchen Spielen dieses Gerät Tore anzeigt und vibriert.</span></div>
</section>` : '';

  // Ohne laufendes Spiel steht hier, wann es wieder losgeht — sonst sieht man von der Live-Ansicht nichts.
  const naechsteAnwuerfe = alle
    .filter(x => x.m.status === 'scheduled' && Date.parse(x.m.starts_at) > now.getTime())
    .sort((a, b) => a.m.starts_at.localeCompare(b.m.starts_at));
  const naechster = naechsteAnwuerfe[0];
  const liveLeerHtml = live.length === 0 ? `<section class="card live-leer" id="live">
  <h2>Live <span class="badge">Gerade kein Spiel</span></h2>
  <p class="livehinweis"><span class="punkt" aria-hidden="true"></span><span>${naechster
    ? `<b>Nächster Anwurf:</b> ${h(DATUM_KURZ.format(new Date(naechster.m.starts_at)))}, ${h(ZEIT.format(new Date(naechster.m.starts_at)))} Uhr, ${h(naechster.t.label)} ${naechster.m.is_home ? 'gegen' : 'bei'} ${h(gegnerVon(naechster.m))}. `
    : 'Zurzeit ist kein Spiel angesetzt. '}Sobald ein Spiel läuft, steht der Spielstand hier ganz oben. Die Seite aktualisiert sich dann alle 30 Sekunden und meldet Tore mit Vibration.</span></p>
</section>` : '';

  const beschreibung = heimspiele.length > 0
    ? `${heimspiele.length} Heimspiel${heimspiele.length === 1 ? '' : 'e'} am Wochenende ${tagMonat(we.fr)}–${tagMonat(we.so)} — Überblick über alle Mannschaften`
    : 'Überblick über alle Mannschaften: Heimspiele, Spielorte und Ergebnisse';
  const auswaertsspiele = alle
    .filter(x => !x.m.is_home && x.m.status !== 'cancelled' && x.m.status !== 'postponed'
      && tage.includes(TAG_ISO.format(new Date(x.m.starts_at))))
    .sort((a, b) => a.m.starts_at.localeCompare(b.m.starts_at));

  /** Eine Wochenend-Tabelle: Heim- oder Auswärtsspiele, sortierbar nach Datum, Spielort und Bereich. */
  const wochenendTabelle = (id: string, ueberschrift: string, zusatz: string, spiele: typeof heimspiele, leer: string) => {
    const zeilen = spiele.map(({ t, m }) => {
      const start = new Date(m.starts_at);
      const fertig = (m.status === 'finished' || m.rated) && m.score_home !== null && m.score_away !== null;
      const name = m.venue_name?.trim() || '';
      const adresse = m.venue_address?.trim() || '';
      const routen = routenLinks(m);
      const rang = t.group ? GRUPPEN_RANG[t.group] : 9;
      const ergebnis = m.is_live ? ' <span class="badge live">Live</span>'
        : fertig ? ` <b class="erg ${m.won === true ? 'w' : m.won === false ? 'l' : ''}">${standHeimGast(m)}</b>` : '';
      return `<tr data-ts="${h(m.starts_at)}" data-ort="${h(name.toLowerCase())}" data-gr="${rang}">
      <td class="wann" data-label="Datum">${h(DATUM_KURZ.format(start))}<small>${h(ZEIT.format(start))} Uhr</small></td>
      <td class="team" data-label="Mannschaft"><a href="${h(link(t, '#naechstes'))}">${h(t.label)}</a>${t.group ? `<small>${h(GRUPPEN_KURZ[t.group])}</small>` : ''}</td>
      <td class="geg" data-label="Gegner">${h(gegnerVon(m))}${ergebnis}<small>${h(m.competition_name)}</small></td>
      <td class="ort" data-label="Spielort">${name || adresse ? `<b>📍 ${name ? h(name) : h(adresse)}</b>${name && adresse ? `<small>${h(adresse)}</small>` : ''}${routen.length > 0 ? `<a href="${h(routen[0].href)}" target="_blank" rel="noopener noreferrer">🧭 Route</a>` : ''}` : '<span class="muted">Halle noch nicht bekannt</span>'}</td>
    </tr>`;
    });
    const sortierung = [['datum', 'Datum'], ['ort', 'Spielort'], ['gruppe', 'Herren · Damen · Jugend']] as const;
    const k = id === 'auswaertsspiele'
      ? klappe('auswaerts', spiele.length > 0 ? `${spiele.length} Auswärtsspiel${spiele.length === 1 ? '' : 'e'} von Freitag bis Sonntag` : 'Kein Auswärtsspiel von Freitag bis Sonntag')
      : { attr: '', zeile: '' };
    return `<section class="card" id="${id}"${k.attr}>
  <h2>${ueberschrift} <span class="muted small">${zusatz} · ${tagMonat(we.fr)}–${tagMonat(we.so)}</span>${id === 'heimspiele' ? teilenHtml({ url: opts.baseUrl, titel: SITE_TITEL, text: beschreibung, bild: './bild/wochenende.png' }).replace('class="btn teilen"', 'class="btn teilen klein"') : ''}</h2>
  ${k.zeile}
  ${spiele.length > 0 ? `<div class="sortieren" data-sortbar hidden role="group" aria-label="${ueberschrift} sortieren">
    <span class="muted small">Sortieren nach</span>
    ${sortierung.map(([k, t], i) => `<button type="button" data-sort="${k}" aria-pressed="${i === 0 ? 'true' : 'false'}">${t}</button>`).join('')}
  </div>
  <div class="tabelle-rahmen"><table class="heim" data-sorttable>
    <thead><tr><th scope="col">Datum</th><th scope="col">Mannschaft</th><th scope="col">Gegner</th><th scope="col">Spielort</th></tr></thead>
    <tbody>${zeilen.join('')}</tbody>
  </table></div>`
    : `<p class="muted">${leer}</p>`}
</section>`;
  };
  // Heute: alle Spiele des Tages, Heim und Auswärts — was gerade läuft steht schon im Live-Kasten.
  const heuteSpiele = alle
    .filter(x => !x.m.is_live && x.m.status !== 'cancelled' && x.m.status !== 'postponed' && TAG_ISO.format(new Date(x.m.starts_at)) === heute)
    .sort((a, b) => a.m.starts_at.localeCompare(b.m.starts_at));
  const heuteHtml = heuteSpiele.length > 0 ? `<section class="card dark" id="heute">
  <h2>Heute <span class="muted small">${h(DATUM_KURZ.format(now))}</span></h2>
  <ul class="plan">${heuteSpiele.map(({ t, m }) => {
    const fertig = (m.status === 'finished' || m.rated) && m.score_home !== null && m.score_away !== null;
    const stand = fertig ? `<span class="e ${m.won === true ? 'w' : m.won === false ? 'l' : ''}">${standHeimGast(m)}</span>` : `<span class="e">${m.is_home ? 'Heim' : 'Auswärts'}</span>`;
    const ort = m.venue_name?.trim() ? ` · ${h(m.venue_name.trim())}` : '';
    return `<li>
      <span class="d">${h(ZEIT.format(new Date(m.starts_at)))} Uhr</span>
      <span class="g"><a class="titel" href="${h(link(t, fertig ? `spiel/${encodeURIComponent(m.match_id)}` : '#naechstes'))}">${h(t.label)}</a><div class="ha">${m.is_home ? 'gegen' : 'bei'} ${h(gegnerVon(m))}${ort}</div></span>
      ${stand}
    </li>`;
  }).join('')}</ul>
</section>` : '';

  // Letztes Wochenende: die Ergebnisse aller Mannschaften, damit man nachlesen kann, wie es war.
  const lw = letztesSpielWochenende(alle.map(x => x.m), kommendes);
  const letzteTage = [lw.fr, lw.sa, lw.so];
  const letzte = alle
    .filter(x => (x.m.status === 'finished' || x.m.rated) && x.m.score_home !== null && x.m.score_away !== null
      && letzteTage.includes(TAG_ISO.format(new Date(x.m.starts_at))))
    .sort((a, b) => a.m.starts_at.localeCompare(b.m.starts_at));
  const siege = letzte.filter(x => x.m.won === true).length;
  const niederlagen = letzte.filter(x => x.m.won === false).length;
  const remis = letzte.length - siege - niederlagen;
  const bilanz = [siege ? `${siege} Sieg${siege === 1 ? '' : 'e'}` : '', remis ? `${remis} Unentschieden` : '', niederlagen ? `${niederlagen} Niederlage${niederlagen === 1 ? '' : 'n'}` : ''].filter(Boolean).join(' · ');
  const kLetzte = klappe('ergebnisse', `${letzte.length} Spiel${letzte.length === 1 ? '' : 'e'}: ${bilanz}`);
  const letzteHtml = letzte.length > 0 ? `<section class="card" id="letztes-wochenende"${kLetzte.attr}>
  <h2>Ergebnisse <span class="muted small">${lw.fr === verschiebeTag(kommendes.fr, -7) ? 'letztes Wochenende' : 'letzter Spieltag'} · ${tagMonat(letzteTage[0]!)}–${tagMonat(letzteTage[2]!)}</span></h2>
  ${kLetzte.zeile}
  <p class="muted small bilanz">${h(bilanz)}</p>
  <ul class="plan">${letzte.map(({ t, m }) => `<li>
      <span class="d">${h(DATUM_KURZ.format(new Date(m.starts_at)))}</span>
      <span class="g"><a class="titel" href="${h(link(t, `spiel/${encodeURIComponent(m.match_id)}`))}">${h(t.label)}</a><div class="ha">${m.is_home ? 'gegen' : 'bei'} ${h(gegnerVon(m))}</div></span>
      <span class="e ${m.won === true ? 'w' : m.won === false ? 'l' : ''}">${standHeimGast(m)}</span>
    </li>`).join('')}</ul>
</section>` : '';

  const wann = laeuft ? 'dieses Wochenende' : spaeter ? 'nächster Spieltag' : 'nächstes Wochenende';
  const weHtml = wochenendTabelle('heimspiele', 'Heimspiele', wann, heimspiele, `Von Freitag bis Sonntag (${tagMonat(we.fr)}–${tagMonat(we.so)}) ist kein Heimspiel angesetzt.`);
  const ausHtml = wochenendTabelle('auswaertsspiele', 'Auswärtsspiele', wann, auswaertsspiele, `Von Freitag bis Sonntag (${tagMonat(we.fr)}–${tagMonat(we.so)}) ist kein Auswärtsspiel angesetzt.`);

  // Der Stand: je Mannschaft Platz, Punkte und das letzte Ergebnis — eine Zeile, kein Spielplan; nach Bereich gruppiert wie die Kästen im Kopf.
  const standZeile = (t: HandballTeamView) => {
    const tabelle = t.standings.find(s => s.rows.some(r => r.teamId === t.team_id));
    const zeile = tabelle?.rows.find(r => r.teamId === t.team_id);
    const l = t.last_match;
    const zuletzt = l && l.score_home !== null && l.score_away !== null
      ? `<span class="erg ${l.won === true ? 'w' : l.won === false ? 'l' : ''}">${standHeimGast(l)}</span> ${l.is_home ? 'gegen' : 'bei'} ${h(gegnerVon(l))}` : '<span class="muted">noch kein Spiel</span>';
    return `<tr>
      <td class="team" data-label="Mannschaft"><a href="${h(link(t))}">${h(t.label)}</a>${tabelle ? `<small>${h(tabelle.competition_name)}</small>` : ''}</td>
      <td data-label="Platz">${zeile ? `<b>${zeile.position}.</b><small>von ${tabelle!.rows.length}</small>` : '<span class="muted">–</span>'}</td>
      <td data-label="Punkte">${zeile ? `<b>${punkteText(zeile)}</b><small>${zeile.played} Sp.</small>` : '<span class="muted">–</span>'}</td>
      <td data-label="Zuletzt">${zuletzt}</td>
    </tr>`;
  };
  const kStand = klappe('stand', teams.length === 1 ? 'Platz, Punkte und letztes Ergebnis der Mannschaft' : `Platz, Punkte und letztes Ergebnis aller ${teams.length} Mannschaften`);
  const standHtml = `<section class="card" id="stand"${kStand.attr}>
  <h2>Tabellenplätze</h2>
  ${kStand.zeile}
  <div class="tabelle-rahmen"><table class="heim stand">
    <thead><tr><th scope="col">Mannschaft</th><th scope="col">Platz</th><th scope="col">Punkte</th><th scope="col">Zuletzt</th></tr></thead>
    ${[...HANDBALL_GROUPS.map(g => ({ label: g.label, teams: teams.filter(t => t.group === g.id) })), { label: 'Weitere', teams: teams.filter(t => t.group === null) }]
      .filter(g => g.teams.length > 0)
      .map(g => `<tbody><tr class="bereich"><th scope="rowgroup" colspan="4">${h(g.label)}</th></tr>${g.teams.map(standZeile).join('')}</tbody>`).join('')}
  </table></div>
</section>`;

  const titel = SITE_TITEL;
  const logo = logoDataUri(erste.team_id);
  const botLink = handballBotLink();
  const botName = getHandballBotUsername();
  const verpassen = verpassenHtml(opts.baseUrl, opts.pushEnabled === true, botLink && botName ? { link: botLink, handle: `@${botName}` } : null, true);
  const kopf = `<header class="hero start"><div class="wrap">
  <button type="button" class="theme" data-theme-toggle hidden aria-label="Farbschema: automatisch" title="Farbschema: automatisch">◐</button>
  ${verpassen.leiste}
  <a class="heim" href="./" aria-label="Zur Startseite">${logo ? `<img class="logo" src="${logo}" alt="">` : `<div class="initialen" aria-hidden="true">${h(initialenVon(erste.name))}</div>`}</a>
  <div class="verein"><a class="heim titel" href="./"><span class="kicker">${h(clubName())}</span></a></div>
  ${gruppenKaesten(teams.map(t => ({ id: t.team_id, label: t.label, group: t.group, url: link(t) })), null, '', true)}
  <div class="teaminfo">
    <h1>${h(titel)}</h1>
    <div class="sub">Heimspiele, Spielorte und Ergebnisse aller Mannschaften</div>
  </div>
</div></header>`;
  const fuss = `<div>Daten von <a href="https://www.handball.net" target="_blank" rel="noopener noreferrer">handball.net</a>${opts.stand ? ` · Stand ${h(STAND.format(new Date(opts.stand)))} Uhr` : ''}. Spielzeiten in deutscher Ortszeit.</div>`;
  return unterseiteHtml({
    titel, beschreibung, url: opts.baseUrl, ogBild: `${opts.baseUrl}${encodeURIComponent(erste.team_id)}/logo.png`, ogLogo: true,
    dateien: `./${encodeURIComponent(erste.team_id)}/`,
    kopf: kopf + sprungleisteHtml([
      ['live', liveHtml ? 'Läuft gerade' : 'Live', liveHtml || liveLeerHtml],
      ['heute', 'Heute', heuteHtml],
      ['heimspiele', 'Heimspiele', weHtml],
      ['auswaertsspiele', 'Auswärtsspiele', ausHtml],
      ['letztes-wochenende', 'Ergebnisse', letzteHtml],
      ['stand', 'Tabellenplätze', standHtml],
    ]), inhalt: `${liveHtml || liveLeerHtml}\n${heuteHtml}\n${weHtml}\n${ausHtml}\n${letzteHtml}\n${standHtml}`, fuss, breit: true, dialog: verpassen.dialog,
    app: { titel: 'Wölfe live', manifest: './manifest.webmanifest' }, live: live.length > 0 || teams.some(t => istLiveFenster(t.next_match, now)),
  });
}

// ---------------------------------------------------------------------------
// Manifest, Service Worker, Skript
// ---------------------------------------------------------------------------

export function renderManifest(team: HandballTeamView): Record<string, unknown> {
  const palette = vervollstaendigePalette(readPalette());
  // Jede Mannschaft ist eine eigene App: Der Name trägt die Mannschaft, sonst stünden auf dem
  // Startbildschirm mehrere gleiche Vereinsnamen nebeneinander.
  return {
    name: `${vereinsName(team.name)} ${team.label}`,
    short_name: team.label,
    description: team.championship_name ? `${team.championship_name} · Spielplan, Ergebnisse, Tabelle` : 'Spielplan, Ergebnisse, Tabelle',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: palette.primary,
    theme_color: palette.primary,
    lang: 'de',
    id: './',
    icons: [
      { src: './logo-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: './logo.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
    shortcuts: [
      { name: 'Nächstes Spiel', url: './#naechstes' },
      { name: 'Tabelle', url: './#tabelle' },
      { name: 'Spielplan', url: './#spielplan' },
    ],
  };
}

/**
 * Das Manifest der Startseite: „Wölfe live" als installierbare App mit
 * der Wurzel als Scope — die Mannschaftsseiten liegen darunter und bleiben
 * in der App. Das Logo kommt von der ersten Mannschaft.
 */
export function renderStartManifest(erste: HandballTeamView): Record<string, unknown> {
  const palette = vervollstaendigePalette(readPalette());
  const logo = `./${encodeURIComponent(erste.team_id)}/`;
  return {
    name: SITE_TITEL,
    short_name: 'Wölfe live',
    description: `${clubName()} · Heimspiele, Spielorte und Ergebnisse aller Mannschaften`,
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: palette.primary,
    theme_color: palette.primary,
    lang: 'de',
    id: './',
    icons: [
      { src: `${logo}logo-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${logo}logo.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
    shortcuts: [
      { name: 'Heimspiele', url: './#heimspiele' },
      { name: 'Tabellenplätze', url: './#stand' },
    ],
  };
}

// ---------------------------------------------------------------------------
// RSS-Feed
// ---------------------------------------------------------------------------

function xml(text: string): string {
  return h(text);
}

/**
 * Der Feed der Mannschaft: Endstände (neueste zuerst), Verlegungen und
 * Absagen, dazu das nächste Spiel als eigener Eintrag, dessen GUID den
 * Termin trägt — ein verlegtes Spiel taucht damit als neuer Eintrag auf.
 * Für Feedreader, die kein Push und kein Telegram brauchen.
 */
export function renderFeedXml(team: HandballTeamView, baseUrl: string, now = new Date()): string {
  const items: Array<{ guid: string; title: string; desc: string; at: Date; link: string }> = [];
  const name = vereinsName(team.name);
  for (const m of gespielt(team)) {
    const start = new Date(m.starts_at);
    const hz = m.halftime_home !== null && m.halftime_away !== null ? ` · Halbzeit ${m.halftime_home}:${m.halftime_away}` : '';
    items.push({
      guid: `result:${m.match_id}`,
      title: `${paarungMitStand(name, m, m.score_home, m.score_away)} · ${ausgangWort(m)}${m.rated ? ' (gewertet)' : ''}`,
      desc: `${DATUM_LANG.format(start)}${hz} · ${m.competition_name}${m.round ? `, ${m.round}. Spieltag` : ''}`,
      at: new Date(Math.min(now.getTime(), start.getTime() + 75 * 60 * 1000)),
      link: m.url,
    });
  }
  for (const c of changesFor(team.team_id)) {
    const m = team.matches.find(x => x.match_id === c.match_id);
    if (!m) continue;
    const paarung = `${name} ${m.is_home ? 'gegen' : 'bei'} ${gegnerVon(m)}`;
    const wann = (iso: string) => `${DATUM_LANG.format(new Date(iso))}, ${ZEIT.format(new Date(iso))} Uhr`;
    const title = c.kind === 'cancelled' ? `Spiel abgesetzt: ${paarung}` : c.kind === 'postponed' ? `Spiel verschoben: ${paarung}` : `Spiel verlegt: ${paarung}`;
    const desc = c.kind === 'rescheduled'
      ? `ursprünglich ${wann(c.old_starts_at)} · jetzt ${wann(c.new_starts_at)}`
      : `war angesetzt für ${wann(c.old_starts_at)}`;
    items.push({ guid: `change:${c.change_id}`, title, desc, at: new Date(c.detected_at), link: m.url });
  }
  const n = team.next_match;
  if (n) {
    const start = new Date(n.starts_at);
    const halle = [n.venue_name, n.venue_address].filter(Boolean).join(', ');
    items.push({
      guid: `fixture:${n.match_id}:${n.starts_at}`,
      title: `Nächstes Spiel: ${name} ${n.is_home ? 'gegen' : 'bei'} ${gegnerVon(n)} — ${DATUM_LANG.format(start)}, ${ZEIT.format(start)} Uhr`,
      desc: `${n.is_home ? 'Heimspiel' : 'Auswärts'}${halle ? ` · ${halle}` : ''} · ${n.competition_name}${n.round ? `, ${n.round}. Spieltag` : ''}`,
      at: new Date(Math.min(now.getTime(), start.getTime() - 7 * 24 * 60 * 60 * 1000)),
      link: n.url,
    });
  }
  items.sort((a, b) => b.at.getTime() - a.at.getTime());
  const rss = items.slice(0, 40).map(i => `    <item>
      <guid isPermaLink="false">${xml(i.guid)}</guid>
      <title>${xml(i.title)}</title>
      <link>${xml(i.link)}</link>
      <description>${xml(i.desc)}</description>
      <pubDate>${i.at.toUTCString()}</pubDate>
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(name)}</title>
    <link>${xml(baseUrl)}</link>
    <atom:link href="${xml(baseUrl)}feed.xml" rel="self" type="application/rss+xml"/>
    <description>${xml(team.championship_name ? `${team.championship_name} — Ergebnisse, Termine, Verlegungen` : 'Ergebnisse, Termine, Verlegungen')}</description>
    <language>de</language>
    <lastBuildDate>${now.toUTCString()}</lastBuildDate>
${rss}
  </channel>
</rss>
`;
}

/** Der Kalender der Seite — dieselbe Datei wie `/kalender` im Bot. */
export function renderSiteIcs(team: HandballTeamView): string {
  return icsKalender(team);
}

/** Die Mannschaft aus der Übersicht, oder null, wenn sie nicht eingetragen ist. */
export function siteTeam(teamId: string): { team: HandballTeamView; stand: string | null } | null {
  const sicht = seitenUebersicht();
  if (!sicht.configured) return null;
  const team = sicht.teams.find(t => t.team_id === teamId);
  return team ? { team, stand: sicht.updated_at } : null;
}
