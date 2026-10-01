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
  handballOverview, logoDataUri, playerGames, playerStats, readPalette, changesFor, tendenzReferenz, opponentFormFor,
  type HandballTeamView, type HandballMatchView,
} from './handballTeam';
import { vervollstaendigePalette, renderPng, type FullPalette } from './handballTableImage';
import {
  bildTabelle, bildKader, bildSpiel, bildVerlauf, bildTorjaeger, bildSaison, endstandBild,
  textSaison, alsKlartext, icsKalender, handballBotLink, getHandballBotUsername,
} from './handballBot';
import type { HandballStandingRow } from './handballNetClient';

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
export async function siteLogoPng(team: HandballTeamView, palette: FullPalette): Promise<Buffer> {
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
   * Alle Mannschaften des Vereins für das Dropdown im Kopf — leer oder eine,
   * und es gibt kein Dropdown. `url` ist relativ (`../96300/`), damit die Seite
   * unter jeder Wurzel funktioniert.
   */
  teams?: Array<{ id: string; label: string; url: string }>;
  /** Ob Web-Push überhaupt möglich ist (VAPID vorhanden) — sonst zeigt die Seite nur Kalender und Feed. */
  pushEnabled: boolean;
  stand: string | null;
  now?: Date;
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

function css(p: FullPalette): string {
  const grund = p.primary.toLowerCase() === '#003e51' ? '#001f2b' : p.primary;
  return `
:root{--p:${p.primary};--s:${p.secondary};--a:${p.accent};--ad:${p.accentDark};--g:${grund};--bg:#f2f6f7;--card:#ffffff;--text:#10262c;--muted:#5d7178;--line:#dde6e9;--win:#1f9d55;--loss:#c9403a;--draw:#7a8a90}
@font-face{font-family:'Barlow Condensed';font-weight:700;font-display:swap;src:url(./fonts/BarlowCondensed-Bold.ttf) format('truetype')}
@font-face{font-family:'Barlow Condensed';font-weight:600;font-display:swap;src:url(./fonts/BarlowCondensed-SemiBold.ttf) format('truetype')}
@font-face{font-family:'Barlow';font-weight:400;font-display:swap;src:url(./fonts/Barlow-Regular.ttf) format('truetype')}
@font-face{font-family:'Barlow';font-weight:500;font-display:swap;src:url(./fonts/Barlow-Medium.ttf) format('truetype')}
@font-face{font-family:'Barlow';font-weight:600;font-display:swap;src:url(./fonts/Barlow-SemiBold.ttf) format('truetype')}
*{box-sizing:border-box}
[hidden]{display:none !important}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 'Barlow',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
a{color:var(--ad)}
h1,h2,h3{font-family:'Barlow Condensed','Barlow',system-ui,sans-serif;letter-spacing:.01em;margin:0}
h2{font-size:1.5rem;font-weight:700;text-transform:uppercase;color:var(--p);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.wrap{max-width:1180px;margin:0 auto;padding:0 16px 48px}
.hero{background:linear-gradient(135deg,var(--g) 0%,var(--p) 45%,var(--s) 100%);color:#fff;position:relative;overflow:hidden}
.hero::before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(-55deg,rgba(255,255,255,.035) 0 2px,transparent 2px 14px);pointer-events:none}
.hero::after{content:"";position:absolute;right:-120px;top:-120px;width:420px;height:420px;border-radius:50%;border:38px solid rgba(255,255,255,.05);pointer-events:none}
.hero .wrap{position:relative;padding-top:28px;padding-bottom:24px;display:grid;grid-template-columns:auto minmax(0,1fr);gap:16px 20px;align-items:center}
.hero img.logo{width:96px;height:96px;object-fit:contain;filter:drop-shadow(0 4px 12px rgba(0,0,0,.35))}
.hero .initialen{width:96px;height:96px;border-radius:50%;background:rgba(255,255,255,.12);display:grid;place-items:center;font-family:'Barlow Condensed',sans-serif;font-size:2.4rem;font-weight:700;color:var(--a)}
.hero h1{font-size:clamp(2rem,6vw,3.4rem);font-weight:700;line-height:1;text-transform:uppercase}
.hero .sub{margin-top:6px;color:rgba(255,255,255,.82);font-size:1rem}
.teamwahl{display:inline-flex;align-items:center;gap:8px;margin-bottom:10px;font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:.85rem;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.72)}
.teamwahl select{font:inherit;font-size:1rem;letter-spacing:0;text-transform:none;color:#fff;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.28);border-radius:10px;padding:6px 10px;max-width:70vw}
.teamwahl select option{color:#111}
.hero .stats{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-top:4px}
.stat{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:10px 12px;min-width:0}
.stat b{display:block;font-family:'Barlow Condensed',sans-serif;font-size:1.75rem;font-weight:700;line-height:1;color:#fff;white-space:nowrap}
.stat b.a{color:var(--a)}
.stat b small{font-size:1rem;font-weight:600;color:rgba(255,255,255,.7);margin-left:4px}
.stat span{display:block;font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.72);margin-top:5px}
.form{display:inline-flex;gap:5px;align-items:center;height:1.75rem}
.form i{display:inline-block;width:12px;height:12px;border-radius:50%;background:var(--draw)}
.form i.w{background:var(--win)}.form i.l{background:var(--loss)}
main.wrap{display:grid;gap:18px;padding-top:18px;grid-template-columns:minmax(0,1fr)}
.col{display:contents}
.s-next{order:1}.s-push{order:2}.s-last{order:3}.s-table{order:4}.s-plan{order:5}.s-season{order:6}.s-team{order:7}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 1px 2px rgba(16,38,44,.04);min-width:0}
.card.dark{background:linear-gradient(135deg,var(--g),var(--p) 60%,var(--s));color:#fff;border-color:transparent}
.card.dark h2{color:var(--a)}
.card.dark a{color:#fff}
.card h2{margin-bottom:10px}
.card img.bild{display:block;width:100%;height:auto;border-radius:12px;background:#0b2a33}
.badge{display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;background:var(--a);color:var(--g);font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:.95rem;letter-spacing:.04em;text-transform:uppercase}
.badge.live{background:var(--loss);color:#fff;animation:puls 1.6s ease-in-out infinite}
@keyframes puls{50%{opacity:.6}}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:12px;border:1px solid var(--line);background:#fff;color:var(--p);font:inherit;font-weight:600;text-decoration:none;cursor:pointer;line-height:1.1}
.btn:hover{border-color:var(--ad)}
.btn.primary{background:var(--a);border-color:var(--a);color:var(--g)}
.btn.ghost{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.25);color:#fff}
.btn[disabled]{opacity:.55;cursor:default}
.muted{color:var(--muted)}
.dark .muted{color:rgba(255,255,255,.72)}
.small{font-size:.9rem}
.next .info{display:grid;gap:4px;margin-top:12px;font-size:1.05rem}
.next .info b{font-family:'Barlow Condensed',sans-serif;font-size:1.5rem;font-weight:700;text-transform:uppercase}
.result .stand{font-family:'Barlow Condensed',sans-serif;font-size:2.6rem;font-weight:700;line-height:1}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:8px 6px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-family:'Barlow Condensed',sans-serif;font-weight:600;text-transform:uppercase;font-size:.9rem;color:var(--muted);letter-spacing:.03em}
td.name,th.name{text-align:left;white-space:normal;width:100%}
tr.own td{background:color-mix(in srgb,var(--a) 14%,#fff);font-weight:600}
tr.own td:first-child{box-shadow:inset 4px 0 0 var(--a)}
td.pos{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:1.1rem;color:var(--p)}
td.pkt{font-weight:700}
.t i{font-style:normal;font-size:.75rem;margin-left:4px}
.t i.up{color:var(--win)}.t i.down{color:var(--loss)}
.legend{margin:10px 0 0;font-size:.85rem;color:var(--muted)}
.plan{list-style:none;margin:0;padding:0;display:grid}
.plan li{display:grid;grid-template-columns:96px 1fr auto;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
.plan li:last-child{border-bottom:0}
.plan .d{font-family:'Barlow Condensed',sans-serif;font-weight:600;color:var(--muted);line-height:1.1}
.plan .d small{display:block;font-weight:500}
.plan .g{min-width:0}
.plan .g .ha{color:var(--muted);font-size:.85rem}
.plan .e{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:1.35rem;padding:2px 10px;border-radius:8px;background:var(--bg);color:var(--text)}
.plan .e.w{background:color-mix(in srgb,var(--win) 16%,#fff);color:var(--win)}
.plan .e.l{background:color-mix(in srgb,var(--loss) 14%,#fff);color:var(--loss)}
.plan .e.o{color:var(--muted);font-weight:500;font-size:.95rem;background:transparent}
.plan li.next{background:color-mix(in srgb,var(--a) 10%,#fff);border-radius:10px;padding-left:8px;padding-right:8px;margin:0 -8px}
.lines{margin:0;padding-left:0;list-style:none;display:grid;gap:6px}
.lines li{padding-left:14px;position:relative}
.lines li::before{content:"";position:absolute;left:0;top:.55em;width:6px;height:6px;border-radius:50%;background:var(--a)}
.season .body{display:grid;gap:14px}
fieldset{border:0;padding:0;margin:0 0 10px}
legend{font-family:'Barlow Condensed',sans-serif;font-weight:600;text-transform:uppercase;font-size:.95rem;color:var(--a);margin-bottom:6px}
.opts{display:flex;gap:8px;flex-wrap:wrap}
.opts label{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.3);cursor:pointer;font-size:.95rem}
.opts input{accent-color:var(--a)}
.opts label:has(input:checked){background:rgba(255,255,255,.14);border-color:var(--a)}
.status{margin:6px 0 10px;font-weight:500}
.lead{margin:0 0 12px;color:rgba(255,255,255,.8)}
.channels{display:grid;gap:10px}
.channel{padding:12px 14px;border-radius:14px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#fff}
.channel[open]{border-color:rgba(255,255,255,.24)}
.channel summary{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:12px;align-items:center;cursor:pointer;list-style:none}
.channel summary::-webkit-details-marker{display:none}
.channel summary::after{content:"▾";font-size:1.1rem;color:var(--a);transition:transform .15s}
.channel[open] summary::after{transform:rotate(180deg)}
.channel .ico{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:var(--a);color:var(--g)}
.channel .ico svg{width:22px;height:22px;fill:currentColor}
.channel .ico.tg{background:#29a9eb;color:#fff}
.channel .ico.rss{background:#f28a1a;color:#fff}
.channel b{display:block;font-family:'Barlow Condensed',sans-serif;font-size:1.2rem;font-weight:700;text-transform:uppercase;letter-spacing:.02em;line-height:1.1}
.channel .body{margin-top:10px}
.channel span.desc{display:block;font-size:.9rem;color:rgba(255,255,255,.75)}
.channel a.open{display:inline-block;margin-top:8px;color:var(--a);font-weight:600;text-decoration:none}
.channel a.open:hover{text-decoration:underline}
.tools{display:flex;gap:8px 14px;flex-wrap:wrap;align-items:center;margin-top:12px;font-size:.9rem;color:rgba(255,255,255,.75)}
.tools a,.tools button{color:#fff;background:none;border:0;padding:0;font:inherit;cursor:pointer;text-decoration:underline;text-decoration-color:rgba(255,255,255,.4);text-underline-offset:3px}
.tools svg{width:16px;height:16px;fill:currentColor;vertical-align:-3px;margin-right:4px}
.gegner{margin-top:14px;padding:12px 14px;border-radius:14px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);display:grid;gap:8px}
.gegner .kopf{display:flex;gap:12px;align-items:center}
.gegner .kopf img,.gegner .kopf .ini{width:44px;height:44px;border-radius:50%;background:#fff;object-fit:contain;flex:none}
.gegner .kopf .ini{display:grid;place-items:center;font-family:'Barlow Condensed',sans-serif;font-weight:700;color:var(--p);background:rgba(255,255,255,.85)}
.gegner .kopf b{display:block;font-family:'Barlow Condensed',sans-serif;font-size:1.15rem;font-weight:700;text-transform:uppercase;letter-spacing:.02em;line-height:1.1}
.gegner .kopf span{display:block;font-size:.9rem;color:rgba(255,255,255,.75)}
.gegner .zeile{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:.95rem}
.gegner .zeile .lbl{font-family:'Barlow Condensed',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:.8rem;color:var(--a);min-width:92px}
.gegner .form i{width:11px;height:11px}
.gegner .res{color:rgba(255,255,255,.85)}
details.more{grid-column:1/-1;margin-top:6px}
details.more summary{cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.04em;font-size:.9rem;color:var(--ad);list-style:none;display:inline-flex;align-items:center;gap:6px}
details.more summary::-webkit-details-marker{display:none}
details.more summary::before{content:"";width:0;height:0;border-left:6px solid currentColor;border-top:4px solid transparent;border-bottom:4px solid transparent;transition:transform .15s}
details.more[open] summary::before{transform:rotate(90deg)}
.verlauf{margin:10px 0 4px}
.verlauf svg{display:block;width:100%;height:auto}
.torfolge{margin:6px 0 0;font-size:.85rem;color:var(--muted);line-height:1.6}
.torfolge b{color:var(--text)}
.bericht{margin-top:10px;font-size:.98rem;line-height:1.55}
.bericht h4{font-family:'Barlow Condensed',sans-serif;font-size:1.1rem;font-weight:700;text-transform:uppercase;color:var(--p);margin:12px 0 4px}
.bericht p{margin:0 0 8px}
.bericht .quelle{font-size:.85rem;color:var(--muted)}
footer.wrap{color:var(--muted);font-size:.85rem;padding-bottom:32px;display:grid;gap:6px}
footer .betreiber{padding-top:10px;border-top:1px solid var(--line)}
@media (max-width:600px){.hide-sm{display:none}.hero img.logo,.hero .initialen{width:72px;height:72px}.plan li{grid-template-columns:78px 1fr auto}}
@media (min-width:960px){
main.wrap{grid-template-columns:minmax(0,1fr) 400px;align-items:start;gap:22px;padding-top:22px}
.col{display:grid;gap:22px;min-width:0}
.hero .wrap{padding-top:36px;padding-bottom:32px;grid-template-columns:auto minmax(0,1fr) auto;gap:16px 28px}
.hero img.logo,.hero .initialen{width:120px;height:120px}
.hero .stats{grid-column:auto;grid-template-columns:repeat(3,minmax(110px,1fr));margin-top:0}
.season .body{grid-template-columns:minmax(0,3fr) minmax(0,2fr);align-items:start}
.season .body .lines{margin-top:0}
.card{padding:22px}
}
@media (prefers-color-scheme:dark){:root{--bg:#0c1a1f;--card:#12262c;--text:#e6f0f2;--muted:#9bb0b6;--line:#1f3840}.btn{background:#12262c;color:#e6f0f2}.plan .e{background:#0c1a1f;color:#e6f0f2}tr.own td{background:color-mix(in srgb,var(--a) 22%,#12262c)}.plan li.next{background:color-mix(in srgb,var(--a) 14%,#12262c)}.plan .e.w{background:color-mix(in srgb,var(--win) 24%,#12262c)}.plan .e.l{background:color-mix(in srgb,var(--loss) 22%,#12262c)}}
`;
}

/** Inline-Icons für die Kanäle — `currentColor`, damit sie die Farbe der Kachel nehmen. */
const ICON: Record<'bell' | 'send' | 'calendar' | 'rss' | 'share', string> = {
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a6 6 0 0 0-6 6v4.2L4 15v1h16v-1l-2-2.8V8a6 6 0 0 0-6-6zm0 20a2.6 2.6 0 0 0 2.5-2h-5A2.6 2.6 0 0 0 12 22z"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 2v2H4v18h16V4h-3V2h-2v2H9V2zm-1 8h12v10H6z"/></svg>',
  rss: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4a16 16 0 0 1 16 16h-3A13 13 0 0 0 4 7zm0 6a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7zm2 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 16a3 3 0 0 0-2.4 1.2l-7-4.1a3 3 0 0 0 0-2.2l7-4.1A3 3 0 1 0 15 5c0 .2 0 .4.1.6l-7 4.1a3 3 0 1 0 0 4.6l7 4.1V19a3 3 0 1 0 3-3z"/></svg>',
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
function heroHtml(team: HandballTeamView, logo: string | null, now: Date, mannschaften: Array<{ id: string; label: string; url: string }>): string {
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
    kacheln.push(`<div class="stat"><b class="a">${naechstes.status === 'live' ? 'Jetzt' : h(inTagen(start, now))}</b><span>${naechstes.status === 'live' ? 'Spiel läuft' : `Nächstes Spiel · ${h(DATUM_KURZ.format(start))}`}</span></div>`);
  }
  // Das Dropdown der Mannschaften des Vereins — nur, wenn es mehr als eine
  // gibt. Ein `<select>` mit relativen Zielen; das Umschalten macht `app.js`
  // (kein Inline-JS, siehe CSP), ohne Skript bleibt es ein Formular ohne Wirkung.
  const wahl = mannschaften.length > 1
    ? `<label class="teamwahl"><span>Mannschaft</span><select data-teams aria-label="Mannschaft wählen">${mannschaften.map(t => `<option value="${h(t.url)}"${t.id === team.team_id ? ' selected' : ''}>${h(t.label)}</option>`).join('')}</select></label>`
    : '';
  return `<header class="hero"><div class="wrap">
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
 * wie Torjäger und Kader. Leer, wenn es beides nicht gibt.
 */
function spielDetailsHtml(m: HandballMatchView, players: boolean, offen = false): string {
  const verlauf = spielverlaufSvg(m);
  const bericht = players && m.report_text ? m.report_text : null;
  if (!verlauf && !bericht) return '';
  const absaetze = bericht
    ? bericht.split(/\n{2,}/).map(a => a.trim()).filter(Boolean).map(a => a.startsWith('## ') ? `<h4>${h(a.slice(3))}</h4>` : `<p>${h(a)}</p>`).join('')
    : '';
  const titel = [verlauf ? 'Spielverlauf' : null, bericht ? 'Spielbericht' : null].filter(Boolean).join(' & ');
  return `<details class="more"${offen ? ' open' : ''}><summary>${titel}</summary>
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
  <h2>${live ? 'Läuft gerade <span class="badge live">Live</span>' : `Nächstes Spiel <span class="badge">${h(inTagen(start, now))}</span>`}</h2>
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
  ${spielDetailsHtml(m, players, true)}
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
    return `<li${m.match_id === naechstesId ? ' class="next"' : ''}>
      <span class="d">${h(datumKurz(start, now))}<small>${m.round ? `${m.round}. Spieltag` : h(ZEIT.format(start))}</small></span>
      <span class="g"><a href="${h(m.url)}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:none">${h(gegnerVon(m))}</a><div class="ha">${m.is_home ? 'Heim' : 'Auswärts'}${m.venue_name ? ` · ${h(m.venue_name)}` : ''}${status && mitStand ? ` · ${h(status)}` : ''}</div></span>
      ${ergebnis}
      ${mitStand && m.status !== 'live' ? spielDetailsHtml(m, players) : ''}
    </li>`;
  }).join('');
  const bilanz = gespielt(team);
  return `<section class="card s-plan" id="spielplan"><h2>Spielplan${bilanz.length > 0 ? ` <span class="muted small" style="font-family:'Barlow',sans-serif;text-transform:none;font-weight:500">${bilanz.length} von ${team.matches.length} gespielt</span>` : ''}</h2><ul class="plan">${items}</ul></section>`;
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

function spielerHtml(team: HandballTeamView): string {
  const stats = playerStats(team.team_id);
  const torjaeger = stats.some(p => p.goals > 0);
  const kader = bildKader(team) !== null;
  if (!torjaeger && !kader) return '';
  return `<section class="card s-team" id="mannschaft">
  <h2>Mannschaft</h2>
  ${torjaeger ? `<img class="bild" src="./bild/torjaeger.png" alt="Torschützen der Saison" loading="lazy" width="800">` : ''}
  ${kader ? `<img class="bild" src="./bild/kader.png" alt="Kader" loading="lazy" width="800" height="450" style="margin-top:14px">` : ''}
</section>`;
}

/**
 * „Nichts verpassen": vier Wege als Kacheln — Browser-Push mit dem Formular
 * darunter, der Telegram-Bot (wenn er registriert ist, mit Einladungscode
 * im Link), das Kalender-Abo und der Feed. Alle Kacheln sind
 * eingeklappt (Icon und Überschrift); dazu „Seite teilen" als Kleingedrucktes.
 */
function pushHtml(baseUrl: string, pushEnabled: boolean, telegram: { link: string; handle: string } | null): string {
  const webcal = baseUrl.replace(/^https?:\/\//, 'webcal://') + 'kalender.ics';
  return `<section class="card dark s-push" id="push" data-push="${pushEnabled ? '1' : '0'}">
  <h2>Nichts verpassen</h2>
  <p class="lead">Ohne App, ohne Konto — such dir den Weg aus, der zu dir passt.</p>
  <div class="channels">
    <details class="channel push">
      <summary><span class="ico">${ICON.bell}</span><b>Im Browser</b></summary>
      <div class="body">
        <span class="desc">Dieses Gerät sagt Bescheid, wenn ein Spiel ansteht und wie es ausgegangen ist.</span>
        <div class="inner">
          <p class="status" data-status>${pushEnabled ? 'Einen Moment …' : 'Benachrichtigungen sind auf diesem Server nicht eingerichtet — die anderen Wege gehen trotzdem.'}</p>
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
    ${telegram ? `<details class="channel">
      <summary><span class="ico tg">${ICON.send}</span><b>Telegram-Bot</b></summary>
      <div class="body">
        <span class="desc">${h(telegram.handle)} · Ankündigung, Halbzeit, Endstand mit Torschützen — und Tabelle, Kader, Spielplan auf Zuruf.</span>
        <a class="open" href="${h(telegram.link)}" target="_blank" rel="noopener noreferrer">Bot öffnen →</a>
      </div>
    </details>` : ''}
    <details class="channel">
      <summary><span class="ico">${ICON.calendar}</span><b>Kalender-Abo</b></summary>
      <div class="body">
        <span class="desc">Alle Spiele im eigenen Kalender. Verlegungen wandern von selbst mit.</span>
        <a class="open" href="${h(webcal)}">Kalender abonnieren →</a>
      </div>
    </details>
    <details class="channel">
      <summary><span class="ico rss">${ICON.rss}</span><b>RSS-Feed</b></summary>
      <div class="body">
        <span class="desc">Endstände, Verlegungen und das nächste Spiel im Feedreader.</span>
        <a class="open" href="./feed.xml">Feed öffnen →</a>
      </div>
    </details>
  </div>
  <div class="tools">
    <button type="button" data-share hidden>${ICON.share} Seite teilen</button>
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
<style>${css(palette)}</style>
</head>
<body>
${heroHtml(team, logo, now, opts.teams ?? [])}
<main class="wrap">
<div class="col main">
${naechstesSpielHtml(team, now)}
${letztesSpielHtml(team, opts.players)}
${tabelleHtml(team)}
${saisonHtml(team, opts.players)}
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
<script src="./app.js" defer></script>
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
    icons: [
      { src: './logo.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}

/**
 * Der Service Worker der Microsite: zeigt den Push und öffnet beim Antippen
 * die Seite. Kein Caching — die Seite soll immer den Stand des Servers
 * zeigen, und offline gibt es nichts Sinnvolles zu zeigen. Relativ zum
 * Scope, damit er auch unter einer eigenen Domain funktioniert.
 */
export const SITE_SW_JS = `/* Handball-Microsite: Push-Empfang. Kein Cache. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (event) {
  var payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = { title: 'Handball', body: event.data ? event.data.text() : '' }; }
  var scope = self.registration.scope;
  var options = {
    body: payload.body || '',
    icon: new URL('logo.png', scope).href,
    badge: new URL('logo.png', scope).href,
    tag: payload.tag || 'handball',
    renotify: !!payload.renotify,
    data: { url: payload.url ? new URL(payload.url, scope).href : scope }
  };
  if (payload.image) options.image = new URL(payload.image, scope).href;
  event.waitUntil(self.registration.showNotification(payload.title || 'Handball', options));
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf(self.registration.scope) === 0 && 'focus' in list[i]) { list[i].navigate(url); return list[i].focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
`;

/**
 * Das Skript der Seite: prüft, ob der Browser Push kann, meldet den Service
 * Worker an, holt den VAPID-Schlüssel von `./push` und trägt die
 * Subscription mit Vorlauf und Modus ein. Ohne Push (kein VAPID, Safari
 * außerhalb des Home-Bildschirms) bleibt der Kalender.
 */
export const SITE_APP_JS = `(function () {
  // Das Dropdown der Mannschaften: Auswahl wechselt zur Seite der Mannschaft.
  var teams = document.querySelector('select[data-teams]');
  if (teams) teams.addEventListener('change', function () { if (teams.value) location.href = teams.value; });

  // „Seite teilen": das Teilen-Blatt des Geräts, sonst der Link in die Zwischenablage.
  var share = document.querySelector('[data-share]');
  if (share && (navigator.share || (navigator.clipboard && navigator.clipboard.writeText))) {
    share.hidden = false;
    share.addEventListener('click', function () {
      var url = location.href.split('#')[0];
      if (navigator.share) { navigator.share({ title: document.title, url: url }).catch(function () {}); return; }
      navigator.clipboard.writeText(url).then(function () {
        var alt = share.innerHTML; share.textContent = 'Link kopiert';
        setTimeout(function () { share.innerHTML = alt; }, 2000);
      }).catch(function () {});
    });
  }

  var root = document.getElementById('push');
  if (!root) return;
  var status = root.querySelector('[data-status]');
  var form = root.querySelector('[data-form]');
  var btnOn = root.querySelector('[data-subscribe]');
  var btnOff = root.querySelector('[data-unsubscribe]');
  var iosHint = root.querySelector('[data-ios]');
  var say = function (text) { status.textContent = text; };
  var isIos = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  var supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  if (root.getAttribute('data-push') !== '1') return;
  if (!supported) {
    if (isIos && !standalone) { say('Auf diesem Gerät geht das nur vom Home-Bildschirm aus.'); iosHint.hidden = false; }
    else say('Dieser Browser kann keine Benachrichtigungen — der Kalender unten geht trotzdem.');
    return;
  }

  var KEY = 'handball-site-push';
  function gemerkt() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function merken(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }
  function wahl() {
    var lead = form.querySelector('input[name=lead]:checked');
    var mode = form.querySelector('input[name=mode]:checked');
    return { lead: lead ? lead.value : '1h', mode: mode ? mode.value : 'all' };
  }
  function setzeWahl(v) {
    if (!v) return;
    var l = form.querySelector('input[name=lead][value="' + v.lead + '"]');
    var m = form.querySelector('input[name=mode][value="' + v.mode + '"]');
    if (l) l.checked = true;
    if (m) m.checked = true;
  }
  function bytes(base64) {
    var padding = '='.repeat((4 - (base64.length % 4)) % 4);
    var raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function zeige(sub) {
    form.hidden = false;
    if (sub) {
      btnOn.textContent = 'Auswahl speichern';
      btnOff.hidden = false;
      var w = wahl();
      say(w.lead === 'aus' && w.mode === 'results' ? 'Eingeschaltet: nur Endstände und Verlegungen.' : 'Eingeschaltet auf diesem Gerät.');
    } else {
      btnOn.textContent = 'Benachrichtigungen einschalten';
      btnOff.hidden = true;
      say(Notification.permission === 'denied'
        ? 'Benachrichtigungen sind für diese Seite blockiert — in den Browser-Einstellungen wieder erlauben.'
        : 'Noch nicht eingeschaltet.');
    }
  }

  var reg = null;
  var config = null;
  navigator.serviceWorker.register('./sw.js', { scope: './' })
    .then(function (r) { reg = r; return fetch('./push', { credentials: 'omit' }); })
    .then(function (res) { return res.json(); })
    .then(function (cfg) {
      config = cfg;
      if (!cfg.enabled || !cfg.public_key) { say('Benachrichtigungen sind auf diesem Server nicht eingerichtet — der Kalender geht trotzdem.'); return null; }
      return navigator.serviceWorker.ready.then(function () { return reg.pushManager.getSubscription(); });
    })
    .then(function (sub) {
      if (!config || !config.enabled) return;
      setzeWahl(gemerkt());
      zeige(sub);
    })
    .catch(function () { say('Benachrichtigungen lassen sich gerade nicht einrichten.'); });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!reg || !config) return;
    btnOn.disabled = true;
    say('Einen Moment …');
    Promise.resolve(Notification.permission === 'granted' ? 'granted' : Notification.requestPermission())
      .then(function (perm) {
        if (perm !== 'granted') { zeige(null); throw new Error('abgelehnt'); }
        return reg.pushManager.getSubscription().then(function (sub) {
          return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(config.public_key) });
        });
      })
      .then(function (sub) {
        var w = wahl();
        return fetch('./push', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit',
          body: JSON.stringify({ subscription: sub.toJSON(), lead: w.lead, mode: w.mode })
        }).then(function (res) { if (!res.ok) throw new Error('server'); merken(w); zeige(sub); });
      })
      .catch(function (err) { if (err && err.message !== 'abgelehnt') say('Das hat nicht geklappt — bitte noch einmal versuchen.'); })
      .then(function () { btnOn.disabled = false; });
  });

  btnOff.addEventListener('click', function () {
    if (!reg) return;
    btnOff.disabled = true;
    reg.pushManager.getSubscription().then(function (sub) {
      if (!sub) return null;
      return fetch('./push', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', body: JSON.stringify({ endpoint: sub.endpoint }) })
        .catch(function () {})
        .then(function () { return sub.unsubscribe(); });
    }).then(function () { zeige(null); say('Ausgeschaltet.'); }).catch(function () { say('Abmelden hat nicht geklappt.'); })
      .then(function () { btnOff.disabled = false; });
  });
})();
`;

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
