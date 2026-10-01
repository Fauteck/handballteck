/**
 * Die Handball-Microsite (docs/handball-verfolgung.md §7): eine öffentliche
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
 * **Spielernamen nur auf Wunsch.** Torjäger, Kader und Saisonkarte nennen
 * Namen von Jugendspielern; sie erscheinen nur mit dem zweiten Schalter der
 * Dienste-Zeile (`site_players`). Die Seite trägt `noindex` — sie ist zum
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
import { siteEnabled, sitePlayers, siteUrl, publicUrl as configPublicUrl, siteOperator, siteFeedbackMail } from '../config';
import {
  handballOverview, logoDataUri, playerGames, playerStats, playerMatchLog, readPalette, changesFor, tendenzReferenz, opponentFormFor,
  type HandballTeamView, type HandballMatchView,
} from './handballTeam';
import { vervollstaendigePalette, renderPng, type FullPalette } from './handballTableImage';
import {
  bildTabelle, bildKader, bildSpiel, bildVerlauf, bildTorjaeger, bildSaison, endstandBild,
  textSaison, alsKlartext, icsKalender, handballBotLink, getHandballBotUsername,
} from './handballBot';
import type { HandballStandingRow } from './handballNetClient';
import { siteCss, inhaltsHash, SITE_SW_JS, SITE_APP_JS, SITE_THEME_JS } from './handballSiteAssets';
import { hatGruppenbild, portraits, istJugend } from './clubdesk';

export { SITE_SW_JS, SITE_APP_JS, SITE_THEME_JS };

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

export interface HandballSiteConfig {
  /** Der Schalter „Microsite freigeben" der Dienste-Zeile. */
  enabled: boolean;
  /** Der Schalter „Spielernamen auf der Microsite zeigen". */
  players: boolean;
  /** Absolute Adresse der Seite mit Schrägstrich am Ende — aus der Dienste-Zeile, sonst der Pfad unter `PUBLIC_URL`. */
  baseUrl: string;
}

/**
 * Die Wurzel, unter der die Seiten liegen: `SITE_URL` (eigene Domain vor dem
 * Proxy), sonst `PUBLIC_URL`. Die Mannschaftsseite ist `<Wurzel>/<Team-ID>/`.
 */
export function siteRootUrl(): string {
  return siteUrl() ?? configPublicUrl();
}

export function siteDefaultUrl(teamId: string): string {
  return `${siteRootUrl()}/${encodeURIComponent(teamId)}/`;
}

export function siteConfig(teamId: string): HandballSiteConfig {
  return { enabled: siteEnabled(), players: sitePlayers(), baseUrl: siteDefaultUrl(teamId) };
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

function eigeneTore(m: HandballMatchView): number | null {
  return m.is_home ? m.score_home : m.score_away;
}
function gegnerTore(m: HandballMatchView): number | null {
  return m.is_home ? m.score_away : m.score_home;
}

/** Statuswort auf Deutsch — die Quelle mischt Deutsch und Spanisch. */
function statusWort(m: HandballMatchView): string | null {
  switch (m.status) {
    case 'live': return 'Live';
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

/** Bilder ohne Spielernamen — immer auf der Seite. */
export const SITE_IMAGES_PUBLIC = ['spiel', 'endstand', 'tabelle', 'verlauf'] as const;
/** Bilder mit Spielernamen — nur mit dem zweiten Schalter. */
export const SITE_IMAGES_PLAYERS = ['torjaeger', 'kader', 'saison'] as const;
export type SiteImageArt = typeof SITE_IMAGES_PUBLIC[number] | typeof SITE_IMAGES_PLAYERS[number];

export function istBildArt(art: string, players: boolean): art is SiteImageArt {
  return (SITE_IMAGES_PUBLIC as readonly string[]).includes(art)
    || (players && (SITE_IMAGES_PLAYERS as readonly string[]).includes(art));
}

// PRF-3-002: Platz für jede Bildart jeder Mannschaft samt Logo und einigen
// Endständen (8 × 12); bei rund 200 KB je PNG etwa 20 MB. Mit 48 verdrängten
// sich die Bilder von acht Mannschaften gegenseitig und wurden neu gerendert.
const BILD_CACHE_MAX = 96;
const BILD_CACHE_TTL_MS = 10 * 60 * 1000;
const bildCache = new Map<string, { stand: string; at: number; png: Buffer }>();

/** Nur für Tests. */
export function resetSiteImageCache(): void {
  bildCache.clear();
}

async function bildSvg(team: HandballTeamView, art: SiteImageArt, matchId: string | null): Promise<string | null> {
  switch (art) {
    case 'tabelle': {
      const s = team.standings[0];
      return s && s.rows.length > 0 ? bildTabelle(team, s) : null;
    }
    case 'kader': return bildKader(team);
    case 'spiel': return team.next_match && team.next_match.status !== 'live' ? bildSpiel(team.next_match) : null;
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
 * Ein Bild der Seite als PNG — aus dem Cache, wenn der Stand der Übersicht
 * derselbe ist und der Eintrag jünger als zehn Minuten; sonst gerendert und
 * abgelegt. `null` heißt: dafür gibt es nichts zu zeichnen.
 */
export async function siteImagePng(team: HandballTeamView, art: SiteImageArt, matchId: string | null, stand: string | null): Promise<Buffer | null> {
  const key = `${team.team_id}:${art}:${matchId ?? ''}`;
  const now = Date.now();
  const hit = bildCache.get(key);
  if (hit && hit.stand === (stand ?? '') && now - hit.at < BILD_CACHE_TTL_MS) return hit.png;
  const svg = await bildSvg(team, art, matchId);
  if (!svg) return null;
  const png = await renderPng(svg);
  if (bildCache.size >= BILD_CACHE_MAX) {
    const aeltester = [...bildCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (aeltester) bildCache.delete(aeltester[0]);
  }
  bildCache.set(key, { stand: stand ?? '', at: now, png });
  return png;
}

/**
 * Das Vereinslogo als quadratisches PNG (512×512) für Manifest, Home-Bildschirm
 * und Benachrichtigung — aus dem gespeicherten Logo, sonst ein Kreis in der
 * Vereinsfarbe mit den Initialen. Gecacht wie die anderen Bilder.
 */
export async function siteLogoPng(team: HandballTeamView, palette: FullPalette, groesse: 192 | 512 = 512): Promise<Buffer> {
  if (groesse === 192) {
    const key192 = `${team.team_id}:logo192`;
    const treffer = bildCache.get(key192);
    if (treffer && Date.now() - treffer.at < 6 * 60 * 60 * 1000) return treffer.png;
    const klein = await sharp(await siteLogoPng(team, palette, 512)).resize(192, 192).png().toBuffer();
    bildCache.set(key192, { stand: '', at: Date.now(), png: klein });
    return klein;
  }
  const key = `${team.team_id}:logo`;
  const hit = bildCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 60 * 60 * 1000) return hit.png;
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
  bildCache.set(key, { stand: '', at: Date.now(), png });
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

export interface SiteRenderOptions {
  players: boolean;
  baseUrl: string;
  /**
   * Alle Mannschaften des Vereins für die Schaltflächen im Kopf — leer oder
   * eine, und es gibt keine. `url` ist relativ (`../96300/`), damit die Seite
   * unter jeder Wurzel funktioniert.
   */
  teams?: Array<{ id: string; label: string; url: string }>;
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
const ICON: Record<'bell' | 'send' | 'calendar' | 'rss', string> = {
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a6 6 0 0 0-6 6v4.2L4 15v1h16v-1l-2-2.8V8a6 6 0 0 0-6-6zm0 20a2.6 2.6 0 0 0 2.5-2h-5A2.6 2.6 0 0 0 12 22z"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 2v2H4v18h16V4h-3V2h-2v2H9V2zm-1 8h12v10H6z"/></svg>',
  rss: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4a16 16 0 0 1 16 16h-3A13 13 0 0 0 4 7zm0 6a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7zm2 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/></svg>',
};

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
  const punkte = letzte.map(m => `<i class="${m.won === true ? 'w' : m.won === false ? 'l' : ''}" title="${h(`${eigeneTore(m)}:${gegnerTore(m)} ${m.is_home ? 'gegen' : 'bei'} ${gegnerVon(m)}`)}"></i>`).join('');
  return `<span class="form" aria-label="Form der letzten ${letzte.length} Spiele">${punkte}</span>`;
}

/**
 * Der Kopf: Logo, Name, Wettbewerb — und die Saison in Kacheln (Platz,
 * Punkte, Bilanz, Tore, Form, nächstes Spiel), damit die Frage „wie
 * stehen wir?" beantwortet ist, bevor jemand scrollt.
 */
function heroHtml(team: HandballTeamView, logo: string | null, now: Date, mannschaften: Array<{ id: string; label: string; url: string }>, anhang = ''): string {
  const zeile = eigeneZeile(team);
  const saison = saisonLabel(team.matches[0]?.season_id);
  const wettbewerb = [team.championship_name, team.standings[0]?.competition_name ?? team.matches[0]?.competition_name].filter(Boolean).join(' · ');
  const initialen = team.name.split(/\s+/).filter(w => /^[A-ZÄÖÜ]/.test(w)).map(w => w[0]).join('').slice(0, 3) || 'HB';
  const naechstes = team.next_match;
  const teams = team.standings[0]?.rows.length ?? 0;
  const form = formStrip(team);
  const kacheln: string[] = [];
  if (zeile) {
    kacheln.push(`<div class="stat"><b class="a">${zeile.position}.<small>von ${teams}</small></b><span>Platz</span></div>`);
    kacheln.push(`<div class="stat"><b>${zeile.points}<small>${zeile.played} Sp.</small></b><span>Punkte</span></div>`);
    kacheln.push(`<div class="stat"><b>${zeile.won}-${zeile.drawn}-${zeile.lost}</b><span>Siege · Unent. · Niederl.</span></div>`);
    kacheln.push(`<div class="stat"><b>${zeile.goalsFor}:${zeile.goalsAgainst}<small>${zeile.goalsDiff > 0 ? '+' : ''}${zeile.goalsDiff}</small></b><span>Tore</span></div>`);
  }
  if (form) kacheln.push(`<div class="stat"><b>${form}</b><span>Form</span></div>`);
  if (naechstes) {
    const start = new Date(naechstes.starts_at);
    kacheln.push(`<div class="stat"><b class="a"${naechstes.status === 'live' ? '' : ` data-countdown="${h(naechstes.starts_at)}"`}>${naechstes.status === 'live' ? 'Jetzt' : h(inTagen(start, now))}</b><span>${naechstes.status === 'live' ? 'Spiel läuft' : `Nächstes Spiel · ${h(DATUM_KURZ.format(start))}`}</span></div>`);
  }
  // Die Mannschaften des Vereins als Schaltflächen — nur, wenn es mehr als eine
  // gibt. Reine Verweise (`../<Team-ID>/`), kein Skript nötig; die Seite
  // der gewählten Mannschaft ist markiert.
  const wahl = mannschaften.length > 1
    ? `<nav class="teamwahl" aria-label="Mannschaft wählen">${mannschaften.map(t => t.id === team.team_id
      ? `<a href="${h(t.url + anhang)}" aria-current="page">${h(t.label)}</a>`
      : `<a href="${h(t.url + anhang)}">${h(t.label)}</a>`).join('')}</nav>`
    : '';
  return `<header class="hero"><div class="wrap">
  <button type="button" class="theme" data-theme-toggle hidden aria-label="Farbschema: automatisch" title="Farbschema: automatisch">◐</button>
  ${logo ? `<img class="logo" src="${logo}" alt="">` : `<div class="initialen" aria-hidden="true">${h(initialen)}</div>`}
  <div>
    ${wahl}
    <h1>${h(team.name)}</h1>
    <div class="sub">${h(wettbewerb)}${saison ? ` · Saison ${h(saison)}` : ''}</div>
  </div>
  ${kacheln.length > 0 ? `<div class="stats">${kacheln.join('')}</div>` : ''}
</div></header>`;
}

/**
 * Der Gegner-Steckbrief unter dem nächsten Spiel — dieselben drei Dinge wie
 * in der Ankündigung des Bots (`gegnerSteckbrief`): seine Tabellenzeile, seine
 * letzten Ergebnisse (aus dem Spielplan, den der Tageslauf für ihn geholt
 * hat — die Seite selbst holt nichts) und der Direktvergleich aus den
 * eigenen Spielen. Leer, wenn es zu ihm nichts zu sagen gibt.
 */
function gegnerSteckbriefHtml(team: HandballTeamView, m: HandballMatchView, now: Date): string {
  const gid = m.is_home ? m.away_id : m.home_id;
  const name = gegnerVon(m);
  const zeile = team.standings.flatMap(s => s.rows).find(r => r.teamId === gid);
  const form = opponentFormFor(gid);
  const letzte = (form?.matches ?? [])
    .filter(g => g.status === 'finished' && g.scoreHome !== null && g.scoreAway !== null && g.id !== m.match_id)
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
    .slice(0, 5)
    .map(g => {
      const heim = g.homeId === gid;
      const eigene = heim ? g.scoreHome! : g.scoreAway!;
      const andere = heim ? g.scoreAway! : g.scoreHome!;
      return { klasse: eigene > andere ? 'w' : eigene < andere ? 'l' : '', text: `${eigene}:${andere} ${heim ? 'gegen' : 'bei'} ${heim ? g.awayName : g.homeName}`, datum: datumKurz(new Date(g.startsAt), now) };
    });
  const duelle = team.matches.filter(h => h.match_id !== m.match_id && (h.status === 'finished' || h.rated) && (h.is_home ? h.away_id : h.home_id) === gid
    && h.score_home !== null && h.score_away !== null);
  if (!zeile && letzte.length === 0 && duelle.length === 0) return '';
  const logo = logoDataUri(gid);
  const initialen = name.split(/\s+/).filter(w => /^[A-ZÄÖÜ]/.test(w)).map(w => w[0]).join('').slice(0, 3) || '?';
  const zeilen: string[] = [];
  if (letzte.length > 0) {
    zeilen.push(`<div class="zeile"><span class="lbl">Zuletzt</span><span class="form">${letzte.slice().reverse().map(l => `<i class="${l.klasse}" title="${h(`${l.text} · ${l.datum}`)}"></i>`).join('')}</span><span class="res">${letzte.slice(0, 3).map(l => h(l.text)).join(' · ')}</span></div>`);
  }
  if (duelle.length > 0) {
    zeilen.push(`<div class="zeile"><span class="lbl">${duelle.length === 1 ? 'Hinspiel' : 'Bisher'}</span><span class="res">${duelle.map(d => `${eigeneTore(d)}:${gegnerTore(d)} (${d.is_home ? 'H' : 'A'})`).join(' · ')}</span></div>`);
  }
  return `<div class="gegner">
    <div class="kopf">${logo ? `<img src="${logo}" alt="">` : `<span class="ini" aria-hidden="true">${h(initialen)}</span>`}<div><b>${h(name)}</b><span>${zeile ? `${zeile.position}. Platz · ${zeile.won}-${zeile.drawn}-${zeile.lost} · ${zeile.goalsFor}:${zeile.goalsAgainst} Tore · ${zeile.points} Pkt` : 'Noch ohne Tabellenzeile'}</span></div></div>
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
    ? `${m.is_home ? m.halftime_home : m.halftime_away}:${m.is_home ? m.halftime_away : m.halftime_home}` : null;
  const gid = `sv${m.match_id.replace(/[^a-z0-9]/gi, '')}`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Spielverlauf: Führung je Spielminute">
<defs><linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="0" y1="${T}" x2="0" y2="${H - B}"><stop offset="0" stop-color="var(--win)" stop-opacity=".35"/><stop offset="${((y0 - T) / (H - T - B)).toFixed(4)}" stop-color="var(--win)" stop-opacity=".35"/><stop offset="${((y0 - T) / (H - T - B)).toFixed(4)}" stop-color="var(--loss)" stop-opacity=".35"/><stop offset="1" stop-color="var(--loss)" stop-opacity=".35"/></linearGradient></defs>
${ticks.map(t => `<line x1="${x(t).toFixed(1)}" y1="${T}" x2="${x(t).toFixed(1)}" y2="${H - B}" stroke="var(--line)" stroke-width="1"${t === 30 ? ' stroke-dasharray="4 4"' : ''}/><text x="${x(t).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${t}${t === 30 && halbzeit ? ` · HZ ${halbzeit}` : ''}</text>`).join('')}
<text x="${L - 6}" y="${(y(maxDiff) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">+${maxDiff}</text>
<text x="${L - 6}" y="${(y(-maxDiff) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">−${maxDiff}</text>
<line x1="${L}" y1="${y0.toFixed(1)}" x2="${W - R}" y2="${y0.toFixed(1)}" stroke="var(--muted)" stroke-width="1"/>
<path d="${flaeche}" fill="url(#${gid})" stroke="none"/>
<path d="${d}" fill="none" stroke="var(--p)" stroke-width="2.5" stroke-linejoin="round"/>
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
 * Spielbericht und Spielverlauf zu einem beendeten Spiel, aufklappbar. Der
 * Verlauf kommt ohne Namen aus und steht immer da; der Bericht ist der Text
 * der Quelle und nennt Spieler — er erscheint nur mit dem zweiten Schalter,
 * wie Torjäger und Kader. Leer, wenn es beides nicht gibt. Immer zugeklappt,
 * auch unter dem letzten Spiel — sonst schiebt der Bericht die Seite lang.
 */
function spielDetailsHtml(m: HandballMatchView, players: boolean): string {
  const verlauf = spielverlaufSvg(m);
  const bericht = players && m.report_text ? m.report_text : null;
  if (!verlauf && !bericht) return '';
  const absaetze = bericht
    ? bericht.split(/\n{2,}/).map(a => a.trim()).filter(Boolean).map(a => a.startsWith('## ') ? `<h4>${h(a.slice(3))}</h4>` : `<p>${h(a)}</p>`).join('')
    : '';
  const titel = [verlauf ? 'Spielverlauf' : null, bericht ? 'Spielbericht' : null].filter(Boolean).join(' & ');
  return `<details class="more"><summary>${titel}</summary>
    ${verlauf ? `<div class="verlauf">${verlauf}</div>${torfolgeText(m)}` : ''}
    ${bericht ? `<div class="bericht">${absaetze}<p class="quelle">Spielbericht von handball.net${m.report_url ? ` · <a href="${h(m.report_url)}" target="_blank" rel="noopener noreferrer">Spielberichtsbogen (PDF)</a>` : ''}</p></div>` : ''}
  </details>`;
}

function naechstesSpielHtml(team: HandballTeamView, now: Date): string {
  const m = team.next_match;
  if (!m) {
    return `<section class="card dark next s-next" id="naechstes"><h2>Nächstes Spiel</h2><p class="muted">Kein weiteres Spiel angesetzt.</p></section>`;
  }
  const start = new Date(m.starts_at);
  const live = m.status === 'live';
  const halle = [m.venue_name, m.venue_address].filter(Boolean).join(', ');
  const routen = routenLinks(m);
  const heute = tageBis(start, now) <= 0;
  return `<section class="card dark next s-next" id="naechstes">
  <h2>${live ? 'Läuft gerade <span class="badge live">Live</span>' : `Nächstes Spiel <span class="badge" data-countdown="${h(m.starts_at)}">${h(inTagen(start, now))}</span>`}</h2>
  ${!live ? `<img class="bild" src="./bild/spiel.png" width="800" height="450" alt="${h(`${m.home_name} gegen ${m.away_name}`)}" loading="eager">` : ''}
  <div class="info">
    <b>${m.is_home ? `gegen ${h(gegnerVon(m))}` : `bei ${h(gegnerVon(m))}`}${live && m.score_home !== null ? ` · ${m.score_home}:${m.score_away}` : ''}</b>
    <span>${heute ? 'Heute' : h(DATUM_LANG.format(start))}, ${h(ZEIT.format(start))} Uhr · ${m.is_home ? 'Heimspiel' : 'Auswärts'}</span>
    ${halle ? `<span>📍 ${h(halle)}</span>` : ''}
    <span class="muted small">${h(m.competition_name)}${m.round ? `, ${m.round}. Spieltag` : ''}</span>
  </div>
  ${gegnerSteckbriefHtml(team, m, now)}
  <div class="row" style="margin-top:14px">
    ${routen.map(r => `<a class="btn ghost" href="${h(r.href)}" target="_blank" rel="noopener noreferrer">🧭 ${h(r.label)}</a>`).join('')}
    <a class="btn ghost" href="${h(m.url)}" target="_blank" rel="noopener noreferrer">Spielseite auf handball.net</a>
  </div>
</section>`;
}

function letztesSpielHtml(team: HandballTeamView, players: boolean): string {
  const m = team.last_match;
  if (!m || m.score_home === null || m.score_away === null) return '';
  const start = new Date(m.starts_at);
  const eigene = eigeneTore(m)!; const gegner = gegnerTore(m)!;
  const ausgang = m.won === true ? 'Sieg' : m.won === false ? 'Niederlage' : 'Unentschieden';
  const hz = m.halftime_home !== null && m.halftime_away !== null
    ? `Halbzeit ${m.is_home ? m.halftime_home : m.halftime_away}:${m.is_home ? m.halftime_away : m.halftime_home}` : '';
  return `<section class="card result s-last" id="letztes">
  <h2>Letztes Spiel</h2>
  <img class="bild" src="./bild/endstand.png?match=${encodeURIComponent(m.match_id)}" width="800" height="450" alt="${h(`Endstand ${m.home_name} ${m.score_home}:${m.score_away} ${m.away_name}`)}" loading="lazy">
  <div class="row" style="margin-top:12px;justify-content:space-between">
    <div>
      <div class="stand">${eigene}:${gegner} <span class="muted" style="font-size:1rem;font-weight:500">${ausgang}${m.rated ? ' (gewertet)' : ''}</span></div>
      <div class="muted">${m.is_home ? 'gegen' : 'bei'} ${h(gegnerVon(m))} · ${h(DATUM_LANG.format(start))}${hz ? ` · ${hz}` : ''}</div>
    </div>
    <div class="row">
      ${m.report_url ? `<a class="btn" href="${h(m.report_url)}" target="_blank" rel="noopener noreferrer">Spielberichtsbogen (PDF)</a>` : ''}
      <a class="btn" href="${h(m.url)}" target="_blank" rel="noopener noreferrer">handball.net</a>
    </div>
  </div>
  ${spielDetailsHtml(m, players)}
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

function tabelleHtml(team: HandballTeamView): string {
  const s = team.standings[0];
  if (!s || s.rows.length === 0) return '';
  const spitze = Math.max(...s.rows.map(r => r.played));
  const referenz = tendenzReferenz(s);
  const gegnerNaechster = team.next_match ? (team.next_match.is_home ? team.next_match.away_id : team.next_match.home_id) : null;
  const zeilen = s.rows.map(r => `<tr class="${r.teamId === team.team_id ? 'own' : ''}">
    <td class="pos">${r.position}</td>
    <td class="name t">${h(r.teamName)}${tendenz(r, referenz)}${r.teamId === gegnerNaechster ? ' <span class="muted small">· nächster Gegner</span>' : ''}</td>
    <td${r.played < spitze ? ' class="muted"' : ''}>${r.played}</td>
    <td class="hide-sm">${r.won}</td><td class="hide-sm">${r.drawn}</td><td class="hide-sm">${r.lost}</td>
    <td class="hide-sm">${r.goalsFor}:${r.goalsAgainst}</td>
    <td>${r.goalsDiff > 0 ? '+' : ''}${r.goalsDiff}</td>
    <td class="pkt">${r.points}</td>
  </tr>`).join('');
  const spieltag = s.rows[0]?.round ?? 0;
  const unvollstaendig = s.rows.some(r => r.played < spitze);
  const hinweise = [
    referenz ? `▲▼ gegenüber dem Stand nach dem ${spieltag - 1}. Spieltag` : null,
    unvollstaendig ? 'Sp grau: weniger Spiele als die Spitze' : null,
  ].filter(Boolean);
  return `<section class="card s-table" id="tabelle">
  <h2>Tabelle</h2>
  <p class="muted small" style="margin:0 0 10px">${h(s.competition_name)}${spieltag ? ` · nach dem ${spieltag}. Spieltag` : ''}${unvollstaendig ? ' · Spieltag noch nicht komplett' : ''}</p>
  <div style="overflow-x:auto"><table>
    <thead><tr><th>#</th><th class="name">Mannschaft</th><th>Sp</th><th class="hide-sm">S</th><th class="hide-sm">U</th><th class="hide-sm">N</th><th class="hide-sm">Tore</th><th>Diff</th><th>Pkt</th></tr></thead>
    <tbody>${zeilen}</tbody>
  </table></div>
  ${hinweise.length > 0 ? `<p class="legend">${hinweise.map(x => h(x!)).join(' · ')}</p>` : ''}
</section>`;
}

function spielplanHtml(team: HandballTeamView, now: Date, players: boolean): string {
  if (team.matches.length === 0) return '';
  const naechstesId = team.next_match?.match_id ?? null;
  const items = team.matches.map(m => {
    const start = new Date(m.starts_at);
    const status = statusWort(m);
    const mitStand = m.score_home !== null && m.score_away !== null && (m.status === 'finished' || m.rated || m.status === 'live');
    let ergebnis: string;
    if (mitStand) {
      const klasse = m.status === 'live' ? '' : m.won === true ? 'w' : m.won === false ? 'l' : '';
      ergebnis = `<span class="e ${klasse}" title="${h(m.status === 'live' ? 'Zwischenstand' : m.won === true ? 'gewonnen' : m.won === false ? 'verloren' : 'unentschieden')}">${eigeneTore(m)}:${gegnerTore(m)}</span>`;
    } else if (status) {
      ergebnis = `<span class="e o">${h(status)}</span>`;
    } else {
      ergebnis = `<span class="e o">${h(ZEIT.format(start))} Uhr</span>`;
    }
    const gespieltEintrag = mitStand && m.status !== 'live';
    return `<li${m.match_id === naechstesId ? ' class="next"' : ''} data-ha="${m.is_home ? 'heim' : 'aus'}" data-st="${gespieltEintrag ? 'gespielt' : 'kommend'}">
      <span class="d">${h(datumKurz(start, now))}<small>${m.round ? `${m.round}. Spieltag` : h(ZEIT.format(start))}</small></span>
      <span class="g"><a href="${h(m.url)}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:none">${h(gegnerVon(m))}</a><div class="ha">${m.is_home ? 'Heim' : 'Auswärts'}${m.venue_name ? ` · ${h(m.venue_name)}` : ''}${status && mitStand ? ` · ${h(status)}` : ''}</div></span>
      ${ergebnis}
      ${mitStand && m.status !== 'live' ? spielDetailsHtml(m, players) : ''}
    </li>`;
  }).join('');
  const bilanz = gespielt(team);
  return `<section class="card s-plan" id="spielplan"><h2>Spielplan${bilanz.length > 0 ? ` <span class="muted small" style="font-family:'Barlow',sans-serif;text-transform:none;font-weight:500">${bilanz.length} von ${team.matches.length} gespielt</span>` : ''}</h2>
  <div class="filter" data-filter-bar role="group" aria-label="Spielplan filtern" hidden>
    ${[['alle', 'Alle'], ['heim', 'Heim'], ['aus', 'Auswärts'], ['kommend', 'Kommend'], ['gespielt', 'Gespielt']].map(([k, l]) => `<button type="button" data-filter="${k}" aria-pressed="${k === 'alle'}">${l}</button>`).join('')}
    ${naechstesId ? '<button type="button" data-jump class="jump">Zum nächsten Spiel ↓</button>' : ''}
  </div>
  <ul class="plan">${items}</ul></section>`;
}

function saisonHtml(team: HandballTeamView, players: boolean): string {
  const zeilen = alsKlartext(textSaison(team)).slice(1);
  const hatVerlauf = bildVerlauf(team) !== null;
  if (zeilen.length === 0 && !hatVerlauf) return '';
  return `<section class="card season s-season" id="saison">
  <h2>Saison</h2>
  <div class="body">
  ${hatVerlauf ? `<img class="bild" src="./bild/verlauf.png" alt="Tabellenplatz je Spieltag" loading="lazy" width="800">` : ''}
  ${zeilen.length > 0 ? `<ul class="lines">${zeilen.map(z => `<li>${h(z)}</li>`).join('')}</ul>` : ''}
  </div>
  ${players && bildSaison(team) ? `<img class="bild" src="./bild/saison.png" alt="Saisonkarte" loading="lazy" width="800" height="450" style="margin-top:14px">` : ''}
</section>`;
}

// Nicht `--p`: die Vereinsfarbe ist dunkel und verschwindet auf der dunklen Karte.
const TOR_FARBEN = ['var(--ad)', '#e0891a', '#8a63d2', '#c9403a', '#1f9d55'];

/**
 * Die Tore der besten Torschützen über die Saison — je Spieler eine
 * Linie mit der Summe nach jedem gespielten Spiel. Nur mit Spielernamen
 * (die Legende nennt sie); null unter zwei Spielen oder ohne Tore.
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
 * Die Fotos der Vereinsseite — bisher nur in der Vorschau. Das Gruppenbild bei
 * Senioren immer, bei der Jugend nur mit Spielernamen; die Porträts nur bei
 * Senioren und nur mit Spielernamen (sie tragen Namen). Leer ohne Fotos.
 */
function teamFotosHtml(team: HandballTeamView, players: boolean, anhang: string): string {
  const jugend = istJugend(team.label, team.championship_name);
  const gruppe = hatGruppenbild(team.team_id) && (!jugend || players);
  const personen = players && !jugend ? portraits(team.team_id) : [];
  if (!gruppe && personen.length === 0) return '';
  const abschnitte = new Map<string, typeof personen>();
  for (const p of personen) abschnitte.set(p.section, [...(abschnitte.get(p.section) ?? []), p]);
  return `<section class="card s-fotos" id="team">
  <h2>Das Team <span class="badge">Vorschau</span></h2>
  ${gruppe ? `<img class="bild" src="./foto/gruppe.jpg${h(anhang)}" alt="${h(`Gruppenbild ${team.name}`)}" loading="lazy" width="1600">` : ''}
  ${[...abschnitte].map(([titel, leute]) => `<h3 class="unter">${h(titel)}</h3>
  <ul class="portraets">${leute.map(p => `<li><img src="./foto/${h(p.contactId)}.jpg${h(anhang)}" alt="" loading="lazy" width="400" height="500"><b>${h(p.name)}</b>${p.position ? `<span>${h(p.position)}</span>` : ''}</li>`).join('')}</ul>`).join('')}
  <p class="muted small" style="margin:10px 0 0">Fotos: Vereinsseite der Wölfe Voreifel (ClubDesk).</p>
</section>`;
}

function spielerHtml(team: HandballTeamView): string {
  const stats = playerStats(team.team_id);
  const torjaeger = stats.some(p => p.goals > 0);
  const kader = bildKader(team) !== null;
  const verlauf = torverlaufHtml(team);
  if (!torjaeger && !kader) return '';
  return `<section class="card s-team" id="mannschaft">
  <h2>Mannschaft</h2>
  ${verlauf ? `<h3 class="unter">Tore im Saisonverlauf</h3>${verlauf}` : ''}
  ${torjaeger ? `<img class="bild" src="./bild/torjaeger.png" alt="Torschützen der Saison" loading="lazy" width="800">` : ''}
  ${kader ? `<img class="bild" src="./bild/kader.png" alt="Kader" loading="lazy" width="800" height="450" style="margin-top:14px">` : ''}
</section>`;
}

/**
 * „Nichts verpassen": vier Wege als Kacheln — Browser-Push mit dem Formular
 * darunter, der Telegram-Bot (wenn er registriert ist, mit Einladungscode
 * im Link), das Kalender-Abo und der Feed. Alle Kacheln sind
 * eingeklappt (Icon und Überschrift).
 */
function pushHtml(baseUrl: string, pushEnabled: boolean, telegram: { link: string; handle: string } | null): string {
  const webcal = baseUrl.replace(/^https?:\/\//, 'webcal://') + 'kalender.ics';
  return `<section class="card dark s-push" id="push" data-push="${pushEnabled ? '1' : '0'}">
  <h2>Nichts verpassen</h2>
  <p class="lead">Ohne App, ohne Konto — such dir den Weg aus, der zu dir passt.</p>
  <div class="channels">
    <details class="channel push" data-key="browser">
      <summary><span class="ico">${ICON.bell}</span><b>Im Browser <span class="chip" data-aktiv hidden>Aktiv</span></b></summary>
      <div class="body">
        <span class="desc">Dieses Gerät sagt Bescheid, wenn ein Spiel ansteht und wie es ausgegangen ist.</span>
        <div class="inner">
          <p class="status" data-status role="status" aria-live="polite">${pushEnabled ? 'Einen Moment …' : 'Benachrichtigungen sind auf diesem Server nicht eingerichtet — die anderen Wege gehen trotzdem.'}</p>
          <form data-form hidden>
            <fieldset>
              <legend>Ankündigung</legend>
              <div class="opts">
                <label><input type="radio" name="lead" value="1h" checked> 1 Stunde vorher</label>
                <label><input type="radio" name="lead" value="3h"> 3 Stunden vorher</label>
                <label><input type="radio" name="lead" value="abend"> Am Vorabend</label>
                <label><input type="radio" name="lead" value="aus"> Keine</label>
              </div>
            </fieldset>
            <fieldset>
              <legend>Was</legend>
              <div class="opts">
                <label><input type="radio" name="mode" value="all" checked> Alles: Ankündigung, Halbzeit, Endstand, Verlegungen</label>
                <label><input type="radio" name="mode" value="results"> Nur Endstände und Verlegungen</label>
              </div>
            </fieldset>
            <div class="row">
              <button class="btn primary" type="submit" data-subscribe>Benachrichtigungen einschalten</button>
              <button class="btn ghost" type="button" data-unsubscribe hidden>Ausschalten</button>
            </div>
          </form>
          <p class="muted small" data-ios hidden>iPhone und iPad: Safari erlaubt Benachrichtigungen nur für Seiten auf dem Home-Bildschirm. Erst „Teilen → Zum Home-Bildschirm", dann von dort öffnen und hier einschalten.</p>
        </div>
      </div>
    </details>
    ${telegram ? `<details class="channel" data-key="telegram">
      <summary><span class="ico tg">${ICON.send}</span><b>Telegram-Bot</b></summary>
      <div class="body">
        <span class="desc">${h(telegram.handle)} · Ankündigung, Halbzeit, Endstand mit Torschützen — und Tabelle, Kader, Spielplan auf Zuruf.</span>
        <a class="open" href="${h(telegram.link)}" target="_blank" rel="noopener noreferrer">Bot öffnen →</a>
      </div>
    </details>` : ''}
    <details class="channel" data-key="kalender">
      <summary><span class="ico">${ICON.calendar}</span><b>Kalender-Abo</b></summary>
      <div class="body">
        <span class="desc">Alle Spiele im eigenen Kalender. Verlegungen wandern von selbst mit.</span>
        <a class="open" href="${h(webcal)}">Kalender abonnieren →</a>
      </div>
    </details>
    <details class="channel" data-key="rss">
      <summary><span class="ico rss">${ICON.rss}</span><b>RSS-Feed</b></summary>
      <div class="body">
        <span class="desc">Endstände, Verlegungen und das nächste Spiel im Feedreader.</span>
        <a class="open" href="./feed.xml">Feed öffnen →</a>
      </div>
    </details>
  </div>
</section>`;
}

/**
 * Die ganze Seite als HTML. Liest nur, was `handballOverview()` schon
 * geliefert hat; kein Aufruf nach draußen. Ab 960 px zwei Spalten: links
 * das Spiel (nächstes, letztes, Tabelle, Saison, Mannschaft), rechts die
 * Wege, nichts zu verpassen, und der Spielplan; am Telefon eine Spalte in
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
      ? `Zuletzt: ${eigeneTore(letztes)}:${gegnerTore(letztes)} ${letztes.is_home ? 'gegen' : 'bei'} ${gegnerVon(letztes)}`
      : 'Spielplan, Ergebnisse und Tabelle';
  const ogBild = naechstes && naechstes.status !== 'live'
    ? `${opts.baseUrl}bild/spiel.png`
    : letztes && letztes.score_home !== null ? `${opts.baseUrl}bild/endstand.png?match=${encodeURIComponent(letztes.match_id)}` : null;
  const wettbewerb = team.standings[0]?.competition_name ?? team.matches[0]?.competition_name ?? '';
  const titel = `${team.name}${team.championship_name ? ` · ${team.championship_name}` : ''}`;
  const botLink = handballBotLink();
  const botName = getHandballBotUsername();
  const telegram = botLink && botName ? { link: botLink, handle: `@${botName}` } : null;
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
<meta name="apple-mobile-web-app-title" content="${h(team.name)}">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta property="og:type" content="website">
<meta property="og:title" content="${h(titel)}">
<meta property="og:description" content="${h(beschreibung)}">
<meta property="og:url" content="${h(opts.baseUrl)}">
${ogBild ? `<meta property="og:image" content="${h(ogBild)}">\n<meta property="og:image:width" content="1600">\n<meta property="og:image:height" content="900">\n<meta name="twitter:card" content="summary_large_image">` : ''}
<link rel="manifest" href="./manifest.webmanifest">
<link rel="icon" href="./logo.png" type="image/png">
<link rel="apple-touch-icon" href="./logo.png">
<link rel="alternate" type="application/rss+xml" title="${h(team.name)} — Ergebnisse" href="./feed.xml">
<script src="./theme.js?v=${inhaltsHash(SITE_THEME_JS)}"></script>
<link rel="stylesheet" href="./site.css?v=${siteCssText().hash}">
</head>
<body${naechstes?.status === 'live' ? ' data-live="1"' : ''}>
<a class="skip" href="#inhalt">Zum Inhalt</a>
${opts.vorschau ? '<div class="vorschau-band" role="note">Vorschau — nur über deinen Vorschau-Link erreichbar. Fotos von der Vereinsseite, Rechte noch nicht geklärt.</div>' : ''}
<div class="offline" data-offline role="status" hidden>Du bist offline — gezeigt wird der zuletzt geladene Stand.</div>
${heroHtml(team, logo, now, opts.teams ?? [], anhang)}
<main class="wrap" id="inhalt">
<div class="col main">
${naechstesSpielHtml(team, now)}
${letztesSpielHtml(team, opts.players)}
${tabelleHtml(team)}
${saisonHtml(team, opts.players)}
${opts.vorschau ? teamFotosHtml(team, opts.players, anhang) : ''}
${opts.players ? spielerHtml(team) : ''}
</div>
<div class="col side">
${pushHtml(opts.baseUrl, opts.pushEnabled, telegram)}
${spielplanHtml(team, now, opts.players)}
</div>
</main>
<footer class="wrap">
  <div>Daten von <a href="https://www.handball.net/team/${encodeURIComponent(team.team_id)}" target="_blank" rel="noopener noreferrer">handball.net</a>${wettbewerb ? ` · ${h(wettbewerb)}` : ''}${opts.stand ? ` · Stand ${h(STAND.format(new Date(opts.stand)))} Uhr` : ''}.
  Spielzeiten in deutscher Ortszeit.</div>
  ${betreiberZeile()}
</footer>
<script src="./app.js?v=${inhaltsHash(SITE_APP_JS)}" defer></script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Manifest, Service Worker, Skript
// ---------------------------------------------------------------------------

export function renderManifest(team: HandballTeamView): Record<string, unknown> {
  const palette = vervollstaendigePalette(readPalette());
  return {
    name: team.name,
    short_name: team.name.length > 12 ? team.name.split(/\s+/).filter(w => w.length > 2).slice(-1)[0] ?? team.name : team.name,
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
  for (const m of gespielt(team)) {
    const start = new Date(m.starts_at);
    const eigene = eigeneTore(m)!; const gegner = gegnerTore(m)!;
    const ausgang = m.won === true ? 'gewinnt' : m.won === false ? 'verliert' : 'spielt unentschieden';
    const hz = m.halftime_home !== null && m.halftime_away !== null
      ? ` · Halbzeit ${m.is_home ? m.halftime_home : m.halftime_away}:${m.is_home ? m.halftime_away : m.halftime_home}` : '';
    items.push({
      guid: `result:${m.match_id}`,
      title: `${team.name} ${ausgang} ${eigene}:${gegner}${m.rated ? ' (gewertet)' : ''} ${m.is_home ? 'gegen' : 'bei'} ${gegnerVon(m)}`,
      desc: `${DATUM_LANG.format(start)}${hz} · ${m.competition_name}${m.round ? `, ${m.round}. Spieltag` : ''}`,
      at: new Date(Math.min(now.getTime(), start.getTime() + 75 * 60 * 1000)),
      link: m.url,
    });
  }
  for (const c of changesFor(team.team_id)) {
    const m = team.matches.find(x => x.match_id === c.match_id);
    if (!m) continue;
    const paarung = `${team.name} ${m.is_home ? 'gegen' : 'bei'} ${gegnerVon(m)}`;
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
      title: `Nächstes Spiel: ${team.name} ${n.is_home ? 'gegen' : 'bei'} ${gegnerVon(n)} — ${DATUM_LANG.format(start)}, ${ZEIT.format(start)} Uhr`,
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
    <title>${xml(team.name)}</title>
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
  const sicht = handballOverview();
  if (!sicht.configured) return null;
  const team = sicht.teams.find(t => t.team_id === teamId);
  return team ? { team, stand: sicht.updated_at } : null;
}
