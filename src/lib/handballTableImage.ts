/**
 * Die Handball-Bilder des Telegram-Bots (Wiki „Handball-Verfolgung (handball.net)“ §5):
 * Tabelle, Kader, Endstand, nächstes Spiel, Tabellenplatz-Verlauf, Torjäger,
 * Tore je Spiel. Gebaut wie die E-Ink-Anzeige (lib/displayRender.ts): ein SVG,
 * mit `sharp` gerastert. Textbreiten werden geschätzt (`estimateTextWidth`),
 * zu lange Namen gekürzt statt in die Nachbarspalte zu laufen.
 *
 * **Zwei Themen, ein Rahmen** (seit 27.09.2026, „Matchday-Optik"): Die
 * **Karten** — Endstand, nächstes Spiel, Kader — stehen dunkel auf dem
 * Petrol-Verlauf des Vereins, mit dem Wolfskopf als Wasserzeichen, dem
 * Hallenmotiv (Torraum-Halbkreis und Freiwurflinie) blass am Rand und
 * feinen Diagonalstreifen; sie sind 800×450, weil Telegram hohe Bilder in der
 * Chat-Vorschau beschneidet. **Tabelle und Diagramme** bleiben hell — zehn
 * Zeilen Zahlen liest man auf Weiß besser. Beide teilen Kopf (Logo,
 * Wettbewerb, Datum) und Fuß (Stand, Bot-Name), damit sechs Bilder wie eine
 * Serie aussehen und nicht wie sechs Bilder.
 *
 * **Farben im Vereins-CD, nicht im Todoteck-CD**: Die Bilder gehen an Leute,
 * die die Mannschaft kennen und Todoteck nicht — sie sollen aussehen wie ein
 * Aushang des Vereins. Petrol `#003e51` und `#015069` sind die Grundfarben
 * der Vereinsseite (woelfevoreifel.clubdesk.com), das Türkis `#0bdbd6` ihr
 * Akzent; das Trikot 26/27 verläuft von demselben Petrol in ein Türkis. Für
 * Text auf Weiß ist das Türkis zu hell, deshalb ein dunkleres `#0e9a94`. Der
 * Gegner bekommt auf den Karten **seine** Farbe: die häufigste gesättigte
 * Farbe seines Logos (`logoAccentColor`), Weiß und Schwarz ignoriert.
 *
 * **Schrift**: Barlow Condensed für Zahlen und Titel, Barlow für Namen (beide
 * SIL Open Font License, `apps/api/assets/fonts`, im Image unter
 * `/usr/share/fonts`). Wo sie fehlt — Tests, ein Container ohne die Dateien
 * —, fällt fontconfig auf DejaVu zurück, und die Breitenschätzung rechnet
 * mit DejaVu, also eher zu breit als zu schmal: Es wird höchstens früher
 * gekürzt, nie überlappt.
 */

import sharp from 'sharp';
import { escapeXml, estimateTextWidth, truncateToWidth } from './textMeasure';
import type { HandballStandingRow } from './handballNetClient';

const WIDTH = 800;
const PAD = 24;
/** Höhe der Karten — 16:9, damit die Chat-Vorschau nichts abschneidet. */
const CARD_H = 450;

const FONT_COND = "'Barlow Condensed', 'DejaVu Sans Condensed', 'DejaVu Sans', sans-serif";
const FONT_BODY = "'Barlow', 'DejaVu Sans', Verdana, sans-serif";
/** Barlow Condensed und Barlow sind so viel schmaler als DejaVu, auf das `estimateTextWidth` geeicht ist. */
const COND_FACTOR = 0.78;
const BODY_FACTOR = 0.92;

/**
 * Die Vereinsfarben — seit 27.09.2026 aus der Dienste-Zeile statt aus dem
 * Code (Wiki „Handball-Verfolgung (handball.net)“ §4): Petrol dunkel/hell und der Türkis-
 * Akzent. `accentDark` ist der Akzent für Text auf Weiß; bei der Wölfe-
 * Palette der von Hand gewählte `#0e9a94`, sonst der Akzent um ein Drittel
 * abgedunkelt — ein helles Türkis ist auf Weiß nicht lesbar.
 */
export interface HandballPalette {
  primary: string;
  secondary: string;
  accent: string;
  accentDark?: string | null;
}

/** Eine Palette, an der nichts mehr fehlt. */
export interface FullPalette { primary: string; secondary: string; accent: string; accentDark: string }

export const DEFAULT_PALETTE: Readonly<FullPalette> = {
  primary: '#003e51',
  secondary: '#015069',
  accent: '#0bdbd6',
  accentDark: '#0e9a94',
};

/** `#rrggbb`, Kleinbuchstaben — die Form, die die Konfiguration verlangt. */
export function istHexFarbe(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim());
}

/** Eine Farbe um `anteil` in Richtung Schwarz ziehen (0 = unverändert, 1 = Schwarz). */
export function abdunkeln(hex: string, anteil: number): string {
  const n = parseInt(hex.slice(1), 16);
  const k = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => Math.round(c * (1 - anteil)));
  return `#${k.map(c => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Sehr dunkle Fassung des Primärtons für den Kartengrund — Wölfe: `#001f2b`. */
function grundton(primary: string): string {
  return primary.toLowerCase() === DEFAULT_PALETTE.primary ? '#001f2b' : abdunkeln(primary, 0.5);
}

/**
 * Eine Palette aus der Konfiguration vervollständigen: fehlende oder
 * ungültige Felder fallen auf die Wölfe-Farben zurück, `accentDark` wird
 * abgeleitet, wenn der Akzent nicht der der Wölfe ist.
 */
export function vervollstaendigePalette(roh?: Partial<HandballPalette> | null): FullPalette {
  const nimm = (v: unknown, fallback: string) => (istHexFarbe(v) ? v.trim().toLowerCase() : fallback);
  const primary = nimm(roh?.primary, DEFAULT_PALETTE.primary);
  const secondary = nimm(roh?.secondary, DEFAULT_PALETTE.secondary);
  const accent = nimm(roh?.accent, DEFAULT_PALETTE.accent);
  const dunkelRoh = roh?.accentDark;
  const accentDark = istHexFarbe(dunkelRoh)
    ? dunkelRoh.trim().toLowerCase()
    : accent === DEFAULT_PALETTE.accent ? DEFAULT_PALETTE.accentDark : abdunkeln(accent, 0.33);
  return { primary, secondary, accent, accentDark };
}

interface LightTheme {
  text: string; muted: string; header: string; headerEnd: string; headerText: string;
  zebra: string; own: string; ownBar: string; accent: string; line: string; background: string;
}
interface DarkTheme {
  bg0: string; bg1: string; bg2: string; accent: string; text: string; soft: string; muted: string; gold: string;
}
/** Die beiden Themen eines Bildes — hell (Tabelle, Diagramme) und dunkel (Karten) — aus einer Palette. */
export interface Theme { L: LightTheme; D: DarkTheme }

/** Sehr helle Fassung des Akzents für die eigene Zeile — Wölfe: `#e4fbfa`. */
function aufhellen(hex: string, anteil: number): string {
  const n = parseInt(hex.slice(1), 16);
  const k = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => Math.round(c + (255 - c) * anteil));
  return `#${k.map(c => c.toString(16).padStart(2, '0')).join('')}`;
}

export function themeFor(roh?: Partial<HandballPalette> | null): Theme {
  const p = vervollstaendigePalette(roh);
  const standard = p.primary === DEFAULT_PALETTE.primary && p.accent === DEFAULT_PALETTE.accent;
  return {
    L: {
      text: TEXT_COLOR,
      muted: '#5b6b73',
      header: p.primary,
      headerEnd: p.secondary,
      headerText: '#ffffff',
      zebra: '#f1f6f7',
      own: standard ? '#e4fbfa' : aufhellen(p.accent, 0.86),
      ownBar: p.accent,
      accent: p.accentDark,
      line: '#dbe5e8',
      background: '#ffffff',
    },
    D: {
      bg0: grundton(p.primary),
      bg1: p.primary,
      bg2: p.secondary,
      accent: p.accent,
      text: '#ffffff',
      soft: '#cfe6ea',
      muted: '#7fa3ac',
      gold: '#f2c94c',
    },
  };
}

/** Textfarbe auf Weiß — unabhängig von der Palette. */
const TEXT_COLOR = '#1f2937';

/** Kleingedrucktes am Fuß jedes Bildes — Stand und der Bot, der es geschickt hat. */
export interface ImageBrand {
  /** Wo es die Seite gibt — „handball.fauteck.eu"; fehlt es, bleibt die rechte Ecke der Fußzeile leer. */
  adresse?: string | null;
  /** „Sa, 26.09.2026 18:32" — fehlt er, entfällt die linke Angabe. */
  stand?: string | null;
}

function breite(s: string, size: number, bold = false, cond = false): number {
  return estimateTextWidth(s, size, bold) * (cond ? COND_FACTOR : BODY_FACTOR);
}
function kuerzen(s: string, size: number, maxWidth: number, bold = false, cond = false): string {
  return truncateToWidth(s, size, maxWidth / (cond ? COND_FACTOR : BODY_FACTOR), bold);
}

interface TextOpts { bold?: boolean; fill?: string; anchor?: 'start' | 'end' | 'middle'; cond?: boolean; weight?: number; ls?: number; opacity?: number }

function text(x: number, y: number, size: number, value: string, opts: TextOpts = {}): string {
  const weight = opts.weight ?? (opts.bold ? 700 : 400);
  return `<text x="${x}" y="${y}" font-family="${opts.cond ? FONT_COND : FONT_BODY}" font-size="${size}"`
    + `${weight !== 400 ? ` font-weight="${weight === 700 ? 'bold' : weight}"` : ''} fill="${opts.fill ?? TEXT_COLOR}"`
    + ` text-anchor="${opts.anchor ?? 'start'}"${opts.ls ? ` letter-spacing="${opts.ls}"` : ''}${opts.opacity !== undefined ? ` opacity="${opts.opacity}"` : ''}>${escapeXml(value)}</text>`;
}

/** Größe des Logos oben rechts auf hellen Bildern; der Titel wird entsprechend gekürzt. */
const LOGO_SIZE = 64;

function defsLight(th: Theme): string {
  return `<defs><linearGradient id="kopf" x1="0" y1="0" x2="1" y2="0">`
    + `<stop offset="0" stop-color="${th.L.header}"/><stop offset="1" stop-color="${th.L.headerEnd}"/>`
    + `</linearGradient>`
    + `<linearGradient id="flaeche" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="${th.L.ownBar}" stop-opacity="0.35"/><stop offset="1" stop-color="${th.L.ownBar}" stop-opacity="0"/>`
    + `</linearGradient></defs>`;
}

function defsDark(th: Theme): string {
  return `<defs>`
    + `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${th.D.bg1}"/><stop offset="0.55" stop-color="${th.D.bg0}"/><stop offset="1" stop-color="${th.D.bg2}"/></linearGradient>`
    + `<linearGradient id="trikot" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${th.D.bg2}"/><stop offset="1" stop-color="${th.D.accent}"/></linearGradient>`
    + `<radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${th.D.accent}" stop-opacity="0.55"/><stop offset="0.6" stop-color="${th.D.accent}" stop-opacity="0.12"/><stop offset="1" stop-color="${th.D.accent}" stop-opacity="0"/></radialGradient>`
    + `</defs>`;
}

/** Hintergrund einer dunklen Karte: Verlauf, Streifen, Hallenmotiv. */
function dunklerGrund(th: Theme, height: number, halleX: number, halleY: number, halleR: number): string {
  return `<rect width="${WIDTH}" height="${height}" fill="url(#bg)"/>`
    + diagonalStreifen(th, height)
    + halle(th, halleX, halleY, halleR);
}

/**
 * Feine 45°-Streifen als ein einziger Pfad. Früher ein `<pattern>` mit
 * `patternTransform="rotate(45)"` — librsvg rastert das Kachel für Kachel
 * und brauchte dafür rund 85 % der Renderzeit einer Karte (über eine halbe
 * Sekunde bei doppelter Auflösung). Gleiche Linien: x + y = k · 14·√2.
 */
function diagonalStreifen(th: Theme, height: number): string {
  const abstand = 14 * Math.SQRT2;
  const d: string[] = [];
  for (let c = 0; c < WIDTH + height; c += abstand) {
    d.push(`M${c.toFixed(1)} 0L${(c - height).toFixed(1)} ${height}`);
  }
  return `<path d="${d.join('')}" stroke="${th.D.text}" stroke-width="1" stroke-opacity="0.05" fill="none"/>`;
}

/**
 * Hallenmotiv: Torraum-Halbkreis (6 m), Freiwurflinie (9 m, gestrichelt),
 * Grundlinie und Tor — blass, als Ornament. Ein Motiv, das nur Handball
 * sein kann.
 */
function halle(th: Theme, x: number, y: number, r: number, opacity = 0.13): string {
  return `<g fill="none" stroke="${th.D.accent}" stroke-width="2" opacity="${opacity}">`
    + `<path d="M ${x - r} ${y} A ${r} ${r} 0 0 1 ${x + r} ${y}"/>`
    + `<path d="M ${x - r * 1.5} ${y} A ${r * 1.5} ${r * 1.5} 0 0 1 ${x + r * 1.5} ${y}" stroke-dasharray="14 10"/>`
    + `<line x1="${x - r * 1.7}" y1="${y}" x2="${x + r * 1.7}" y2="${y}"/>`
    + `<line x1="${x - 24}" y1="${y - r * 1.2}" x2="${x + 24}" y2="${y - r * 1.2}" stroke-width="3"/></g>`;
}

/** Logo oben rechts auf hellen Bildern, sofern eines da ist; gibt die Breite zurück, die der Titel freihalten muss. */
function logoHell(parts: string[], dataUri: string | null | undefined): number {
  if (!dataUri) return 0;
  parts.push(`<image href="${dataUri}" x="${WIDTH - PAD - LOGO_SIZE}" y="${PAD - 6}" width="${LOGO_SIZE}" height="${LOGO_SIZE}" preserveAspectRatio="xMidYMid meet"/>`);
  return LOGO_SIZE + 16;
}

let clipZaehler = 0;
/** Ein Logo als Kreis mit Ring — die quadratischen JPEGs der Quelle haben weiße Ecken, die auf Dunkel stören würden. */
function logoKreis(th: Theme, x: number, y: number, r: number, href: string | null | undefined, ring: string, initialen?: string): string {
  const id = `lk${++clipZaehler}`;
  let out = `<circle cx="${x}" cy="${y}" r="${r + 3}" fill="none" stroke="${ring}" stroke-width="3" opacity="0.9"/>`;
  if (href) {
    out += `<clipPath id="${id}"><circle cx="${x}" cy="${y}" r="${r}"/></clipPath>`
      + `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffffff"/>`
      + `<image href="${href}" x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>`;
  } else {
    out += `<circle cx="${x}" cy="${y}" r="${r}" fill="${th.D.text}" opacity="0.08"/>`;
    if (initialen) out += text(x, y + r * 0.35, r, initialen, { cond: true, weight: 700, fill: th.D.soft, anchor: 'middle' });
  }
  return out;
}

/** Logo als Wasserzeichen, ein großer Kreis, kaum sichtbar. */
function wasserzeichen(href: string | null | undefined, x: number, y: number, r: number, opacity = 0.07): string {
  if (!href) return '';
  const id = `wz${++clipZaehler}`;
  return `<clipPath id="${id}"><circle cx="${x}" cy="${y}" r="${r}"/></clipPath>`
    + `<image href="${href}" x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" clip-path="url(#${id})" opacity="${opacity}" preserveAspectRatio="xMidYMid slice"/>`;
}

/** Zwei Buchstaben aus einem Vereinsnamen — für den Platzhalter ohne Logo. */
function initialen(name: string): string {
  const woerter = name.replace(/\b(e\.?\s?V\.?|II|III|IV)\b/g, '').split(/[\s/]+/).filter(Boolean);
  return woerter.slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}

/** Trikot mit Nummer, 32×32-Raster skaliert auf `s`. */
function trikot(th: Theme, x: number, y: number, s: number, nummer: string, fill: string): string {
  const d = 'M9 3 L13 1 Q16 5 19 1 L23 3 L31 8 L27 14 L23 12 L23 30 Q16 32 9 30 L9 12 L5 14 L1 8 Z';
  return `<g transform="translate(${x},${y}) scale(${(s / 32).toFixed(4)})"><path d="${d}" fill="${fill}" stroke="${th.D.text}" stroke-opacity="0.35" stroke-width="1"/></g>`
    + text(x + s / 2, y + s * 0.72, s * 0.5, nummer, { cond: true, weight: 700, fill: th.D.text, anchor: 'middle' });
}

function marke(th: Theme, x: number, y: number, label: string, fill: string, textFill = th.D.bg0): string {
  const w = 12 + label.length * 8;
  return `<rect x="${x}" y="${y - 12}" width="${w}" height="16" rx="4" fill="${fill}"/>` + text(x + w / 2, y, 11, label, { cond: true, weight: 700, fill: textFill, anchor: 'middle', ls: 1 });
}

function pille(cx: number, cy: number, label: string, fill: string, textFill: string, size = 18): string {
  const w = Math.max(80, breite(label, size, true, true) + 40);
  return `<rect x="${cx - w / 2}" y="${cy - 15}" width="${w}" height="30" rx="15" fill="${fill}"/>`
    + text(cx, cy + 7, size, label, { cond: true, weight: 700, fill: textFill, anchor: 'middle', ls: 3 });
}

/** Fußzeile: links Stand (und was der Aufrufer sonst noch sagen will), rechts der Bot. */
function fuss(th: Theme, parts: string[], height: number, brand: ImageBrand | null | undefined, dunkel: boolean, links?: string | null): void {
  const fill = dunkel ? th.D.muted : th.L.muted;
  const teile = [brand?.stand ? `Stand: ${brand.stand}` : null, links].filter(Boolean) as string[];
  if (teile.length > 0) parts.push(text(PAD, height - 14, 12, teile.join(' · '), { fill, ls: 0.3 }));
  // Ohne Bot-Handle bleibt die rechte Ecke leer: Die Bilder gehen seit der
  // Microsite (Wiki „Handball-Verfolgung (handball.net)“ §7) auch an Leute ohne Bot.
  if (brand?.adresse) parts.push(text(WIDTH - PAD, height - 14, 12, brand.adresse, { fill, anchor: 'end', ls: 0.3 }));
}
const FUSS_H = 26;

/** Kopfzeile einer dunklen Karte: links Wettbewerb und Zusatz, rechts das Datum, darunter eine Linie. */
function kopfDunkel(th: Theme, parts: string[], links: string, rechts: string | null | undefined): void {
  parts.push(text(PAD, 38, 15, kuerzen(links.toUpperCase(), 15, WIDTH / 2 + 60, false, true), { cond: true, weight: 600, fill: th.D.accent, ls: 2 }));
  if (rechts) parts.push(text(WIDTH - PAD, 38, 15, rechts.toUpperCase(), { cond: true, weight: 600, fill: th.D.soft, anchor: 'end', ls: 2 }));
  parts.push(`<line x1="${PAD}" y1="52" x2="${WIDTH - PAD}" y2="52" stroke="${th.D.text}" stroke-width="1" opacity="0.15"/>`);
}

/** Kopf eines hellen Bildes: Titel, Untertitel, Logo oben rechts; gibt die y-Kante darunter zurück. */
function kopfHell(th: Theme, parts: string[], title: string, subtitle: string | null | undefined, logoUri: string | null | undefined): number {
  const frei = logoHell(parts, logoUri);
  parts.push(text(PAD, PAD + TITLE_SIZE - 6, TITLE_SIZE, kuerzen(title, TITLE_SIZE, WIDTH - 2 * PAD - frei, true, true), { cond: true, weight: 700, fill: th.L.header }));
  if (subtitle) parts.push(text(PAD, PAD + TITLE_SIZE + SUB_SIZE + 4, SUB_SIZE, subtitle, { cond: true, weight: 500, fill: th.L.accent, ls: 1 }));
  return PAD + TITLE_SIZE + (subtitle ? SUB_SIZE + 10 : 0) + 18;
}

function rahmenHell(th: Theme, height: number): string[] {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">`,
    defsLight(th),
    `<rect width="${WIDTH}" height="${height}" fill="${th.L.background}"/>`,
  ];
}

function rahmenDunkel(th: Theme, height: number, halleX: number, halleY: number, halleR: number): string[] {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">`,
    defsDark(th),
    dunklerGrund(th, height, halleX, halleY, halleR),
  ];
}

const TITLE_SIZE = 28;
const SUB_SIZE = 15;
const HEAD_SIZE = 14;
const ROW_SIZE = 17;
const HEAD_H = 38;
const ROW_H = 40;

// ---------------------------------------------------------------------------
// Tabelle (hell)
// ---------------------------------------------------------------------------

/** Größe der Vereinslogos in der Tabellenzeile. */
const ROW_LOGO = 26;
/** Spalten: x ist die Ankerkante, `align` sagt, welche. */
const COLS = [
  { key: 'pos', label: '#', x: PAD + 30, align: 'end' as const },
  { key: 'name', label: 'Mannschaft', x: PAD + 46 + ROW_LOGO + 10, align: 'start' as const },
  { key: 'played', label: 'Sp', x: 530, align: 'end' as const },
  { key: 'sun', label: 'S-U-N', x: 606, align: 'end' as const },
  { key: 'goals', label: 'Tore', x: 692, align: 'end' as const },
  { key: 'diff', label: 'Diff.', x: 742, align: 'end' as const },
  { key: 'points', label: 'Pkt', x: WIDTH - PAD, align: 'end' as const },
];
/** Wie breit der Name werden darf, bevor er gekürzt wird. */
const NAME_MAX_WIDTH = COLS[2].x - 40 - COLS[1].x;

export interface StandingsImageInput {
  competitionName: string;
  /** Hervorgehoben wird die Zeile mit dieser Team-ID. */
  ownTeamId: string;
  rows: HandballStandingRow[];
  /** Zweite Zeile unter dem Titel, z. B. „B-Jugend · nach dem 3. Spieltag". */
  subtitle?: string | null;
  /** Vereinslogo als Data-URI (`logoDataUri`), oben rechts. */
  logo?: string | null;
  /** Der Vergleichsstand — daraus die Tendenzpfeile je Zeile (▲ geklettert, ▼ gerutscht). Der Aufrufer gibt den Stand nach dem vorigen Spieltag (`tendenzReferenz`), nicht den letzten Abruf. */
  previousRows?: HandballStandingRow[] | null;
  /** Die Zeile des nächsten Gegners wird hell markiert und in der Fußzeile erklärt. */
  nextOpponentId?: string | null;
  /** Vereinslogo je Team-ID für die Zeile; ohne Logo stehen die Initialen im Kreis. */
  logos?: Record<string, string | null | undefined> | null;
  brand?: ImageBrand | null;
  /** Die Vereinsfarben (Konfiguration); ohne Angabe die der Wölfe Voreifel. */
  palette?: Partial<HandballPalette> | null;
}

const COLOR_DOWN = '#c0392b';
const COLOR_NEXT = '#fdf3e1';
const COLOR_NEXT_BAR = '#e8a33d';

export function renderStandingsSvg(input: StandingsImageInput): string {
  const th = themeFor(input.palette);
  const rows = [...input.rows].sort((a, b) => a.position - b.position);
  const vorher = new Map((input.previousRows ?? []).map(r => [r.teamId, r.position]));
  const top = PAD + TITLE_SIZE + (input.subtitle ? SUB_SIZE + 10 : 0) + 18;
  const naechster = input.nextOpponentId && rows.some(r => r.teamId === input.nextOpponentId) ? input.nextOpponentId : null;
  const meisteSpiele = Math.max(0, ...rows.map(r => r.played));
  const unvollstaendig = rows.some(r => r.played < meisteSpiele);
  const fussH = naechster || unvollstaendig ? 22 : 0;
  const height = top + HEAD_H + rows.length * ROW_H + fussH + (input.brand ? FUSS_H : 0) + PAD;
  const parts = rahmenHell(th, height);
  kopfHell(th, parts, input.competitionName, input.subtitle, input.logo);

  parts.push(`<rect x="${PAD}" y="${top}" width="${WIDTH - 2 * PAD}" height="${HEAD_H}" rx="6" fill="url(#kopf)"/>`);
  const headY = top + HEAD_H / 2 + HEAD_SIZE / 2 - 2;
  for (const c of COLS) parts.push(text(c.x, headY, HEAD_SIZE, c.label, { cond: true, weight: 700, fill: th.L.headerText, anchor: c.align, ls: 0.5 }));

  rows.forEach((r, i) => {
    const y = top + HEAD_H + i * ROW_H;
    const own = r.teamId === input.ownTeamId;
    if (own) {
      parts.push(`<rect x="${PAD}" y="${y}" width="${WIDTH - 2 * PAD}" height="${ROW_H}" fill="${th.L.own}"/>`);
      parts.push(`<rect x="${PAD}" y="${y}" width="5" height="${ROW_H}" fill="${th.L.ownBar}"/>`);
    } else if (r.teamId === naechster) {
      parts.push(`<rect x="${PAD}" y="${y}" width="${WIDTH - 2 * PAD}" height="${ROW_H}" fill="${COLOR_NEXT}"/>`);
      parts.push(`<rect x="${PAD}" y="${y}" width="5" height="${ROW_H}" fill="${COLOR_NEXT_BAR}"/>`);
    } else if (i % 2 === 1) {
      parts.push(`<rect x="${PAD}" y="${y}" width="${WIDTH - 2 * PAD}" height="${ROW_H}" fill="${th.L.zebra}"/>`);
    }
    parts.push(`<line x1="${PAD}" y1="${y + ROW_H}" x2="${WIDTH - PAD}" y2="${y + ROW_H}" stroke="${th.L.line}" stroke-width="1"/>`);
    const ty = y + ROW_H / 2 + ROW_SIZE / 2 - 2;
    const bold = own;
    // Logo im Kreis, sonst Initialen — jede Zeile bekommt dasselbe Maß, damit die Namen fluchten.
    const cx = PAD + 46 + ROW_LOGO / 2;
    const cy = y + ROW_H / 2;
    const uri = input.logos?.[r.teamId];
    if (uri) {
      const id = `tl${++clipZaehler}`;
      parts.push(`<clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${ROW_LOGO / 2}"/></clipPath>`);
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${ROW_LOGO / 2}" fill="#ffffff" stroke="${th.L.line}" stroke-width="1"/>`);
      parts.push(`<image href="${uri}" x="${cx - ROW_LOGO / 2}" y="${cy - ROW_LOGO / 2}" width="${ROW_LOGO}" height="${ROW_LOGO}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>`);
    } else {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${ROW_LOGO / 2}" fill="${th.L.zebra}" stroke="${th.L.line}" stroke-width="1"/>`);
      parts.push(text(cx, cy + 4, 10, initialen(r.teamName), { cond: true, weight: 700, fill: th.L.muted, anchor: 'middle' }));
    }
    const name = truncateToWidth(r.teamName, ROW_SIZE, NAME_MAX_WIDTH, bold);
    const werte: Record<string, string> = {
      pos: String(r.position),
      name,
      played: String(r.played),
      sun: `${r.won}-${r.drawn}-${r.lost}`,
      goals: `${r.goalsFor}:${r.goalsAgainst}`,
      diff: r.goalsDiff > 0 ? `+${r.goalsDiff}` : String(r.goalsDiff),
      points: String(r.points),
    };
    for (const c of COLS) {
      const nachzuholen = c.key === 'played' && r.played < meisteSpiele;
      const fill = c.key === 'pos' || nachzuholen ? th.L.muted : c.key === 'points' ? th.L.accent : th.L.text;
      const zahl = c.key !== 'name';
      parts.push(text(c.x, ty, zahl ? ROW_SIZE + 1 : ROW_SIZE, werte[c.key], { bold: (bold || c.key === 'points') && !nachzuholen, fill, anchor: c.align, cond: zahl }));
    }
    const davor = vorher.get(r.teamId);
    if (davor !== undefined && davor !== r.position) {
      const rauf = davor > r.position;
      parts.push(text(PAD + 8, ty - 1, 12, rauf ? '▲' : '▼', { fill: rauf ? th.L.accent : COLOR_DOWN }));
    }
  });
  if (naechster || unvollstaendig) {
    const fy = top + HEAD_H + rows.length * ROW_H + 16;
    let fx = PAD;
    if (naechster) {
      parts.push(`<rect x="${fx}" y="${fy - 9}" width="10" height="10" rx="2" fill="${COLOR_NEXT_BAR}"/>`);
      parts.push(text(fx + 16, fy, 12, 'nächster Gegner', { fill: th.L.muted }));
      fx += 16 + estimateTextWidth('nächster Gegner', 12) + 24;
    }
    if (unvollstaendig) {
      parts.push(text(fx, fy, 12, 'Sp grau: Spieltag noch nicht komplett — weniger Spiele als die Spitze', { fill: th.L.muted }));
    }
  }
  if (input.brand) fuss(th, parts, height, input.brand, false);

  parts.push('</svg>');
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Kader als Mannschaftsbogen (dunkel)
// ---------------------------------------------------------------------------

export interface RosterImageInput {
  teamName: string;
  /** Rechts oben, z. B. „B-Jugend · Kreisoberliga mB". */
  subtitle?: string | null;
  /** Spieler in Kader-Reihenfolge (nach Nummer); `number` null heißt „–"; `numberFromLineup` steht auf dunklem Trikot, `goalkeeper` bekommt „TW", `captain` ein „C". */
  players: Array<{ number: number | null; name: string; numberFromLineup?: boolean; goalkeeper?: boolean; captain?: boolean }>;
  /** Trainer und Betreuer — unter den Spielern, über die volle Breite, bei Bedarf in mehreren Zeilen. */
  staff: string[];
  /** Kleingedrucktes neben den Trainern, z. B. der Hinweis auf getauschte Nummern. */
  footnote?: string | null;
  /** Vereinslogo als Data-URI (`logoDataUri`). */
  logo?: string | null;
  brand?: ImageBrand | null;
  /** Die Vereinsfarben (Konfiguration); ohne Angabe die der Wölfe Voreifel. */
  palette?: Partial<HandballPalette> | null;
}

const ROSTER_COLS = 2;
const ROSTER_GAP = 20;
const ROSTER_COL_W = (WIDTH - 2 * PAD - ROSTER_GAP * (ROSTER_COLS - 1)) / ROSTER_COLS;
const ROSTER_ROW_H = 44;
const ROSTER_TOP = 118;
const ROSTER_NAME_X = 52;
/** Platz für den Namen: die Spalte abzüglich Trikot und der beiden Marken rechts. */
const ROSTER_NAME_MAX_WIDTH = ROSTER_COL_W - ROSTER_NAME_X - 84;
/** Die Trainerzeile beginnt hinter dem Klemmbrett-Symbol und darf bis zum rechten Rand laufen. */
const ROSTER_STAFF_X = 58;
const ROSTER_STAFF_MAX_WIDTH = WIDTH - PAD - ROSTER_STAFF_X;
const ROSTER_STAFF_LINE_H = 22;

/**
 * Namen mit „ · " zu Zeilen fügen, die in `maxWidth` passen — der Umbruch
 * fällt zwischen zwei Namen, nie in einen hinein. Ein einzelner Name, der
 * allein nicht passt, wird gekürzt statt die Zeile zu sprengen. Bis zum
 * 28.09.2026 stand der Stab in **einer** Zeile auf halber Bildbreite und
 * drei Trainer wurden zu „Tobias Wiemken · Frank Kalenborn · F…".
 */
export function zeilenAusNamen(namen: string[], size: number, maxWidth: number): string[] {
  const out: string[] = [];
  let zeile = '';
  for (const roh of namen) {
    const name = truncateToWidth(roh, size, maxWidth, false);
    const probe = zeile ? `${zeile} · ${name}` : name;
    if (zeile && estimateTextWidth(probe, size) > maxWidth) {
      out.push(zeile);
      zeile = name;
    } else {
      zeile = probe;
    }
  }
  if (zeile) out.push(zeile);
  return out;
}

/**
 * Der Kader wie ein Mannschaftsbogen: Trikot mit Nummer, Name, Marken für
 * Torwart und Kapitän rechtsbündig (damit sie nie am Namen kleben), zwei
 * Spalten — sechzehn Spieler untereinander wären ein Bild, das am Telefon
 * dreimal so hoch wie breit ist. Ein dunkles Trikot heißt: Die Nummer kommt
 * aus der letzten Aufstellung, nicht aus dem Kader.
 */
export function renderRosterSvg(input: RosterImageInput): string {
  const th = themeFor(input.palette);
  const players = input.players;
  const perCol = Math.max(1, Math.ceil(players.length / ROSTER_COLS));
  const staffZeilen = zeilenAusNamen(input.staff, 17, ROSTER_STAFF_MAX_WIDTH);
  const staffH = (staffZeilen.length > 0 ? 42 + staffZeilen.length * ROSTER_STAFF_LINE_H : 16) + (input.footnote ? 22 : 0);
  const height = ROSTER_TOP + perCol * ROSTER_ROW_H + staffH + FUSS_H + 8;
  const parts = rahmenDunkel(th, height, WIDTH - 80, height + 40, 110);
  parts.push(wasserzeichen(input.logo, WIDTH - 120, 120, 200, 0.06));

  parts.push(logoKreis(th, 60, 58, 34, input.logo, th.D.accent, initialen(input.teamName)));
  parts.push(text(112, 52, 36, 'KADER', { cond: true, weight: 700, fill: th.D.accent, ls: 4 }));
  parts.push(text(112, 82, 24, kuerzen(input.teamName, 24, 360, false, true), { cond: true, weight: 600, fill: th.D.text, ls: 1 }));
  if (input.subtitle) parts.push(text(WIDTH - PAD, 52, 15, input.subtitle.toUpperCase(), { cond: true, weight: 600, fill: th.D.soft, anchor: 'end', ls: 2 }));
  parts.push(text(WIDTH - PAD, 76, 15, `${players.length} SPIELER`, { cond: true, weight: 500, fill: th.D.muted, anchor: 'end', ls: 2 }));
  parts.push(`<line x1="${PAD}" y1="${ROSTER_TOP - 14}" x2="${WIDTH - PAD}" y2="${ROSTER_TOP - 14}" stroke="${th.D.accent}" stroke-width="2" opacity="0.6"/>`);

  players.forEach((p, i) => {
    const c = Math.floor(i / perCol);
    const r = i % perCol;
    const x0 = PAD + c * (ROSTER_COL_W + ROSTER_GAP);
    const y = ROSTER_TOP + r * ROSTER_ROW_H;
    if (r % 2 === 0) parts.push(`<rect x="${x0}" y="${y}" width="${ROSTER_COL_W}" height="${ROSTER_ROW_H}" rx="6" fill="${th.D.text}" opacity="0.04"/>`);
    parts.push(trikot(th, x0 + 8, y + 6, 32, p.number === null ? '–' : String(p.number), p.numberFromLineup ? th.D.bg2 : 'url(#trikot)'));
    parts.push(text(x0 + ROSTER_NAME_X, y + 28, 18, truncateToWidth(p.name, 18, ROSTER_NAME_MAX_WIDTH, false), { weight: 500, fill: th.D.text }));
    let bx = x0 + ROSTER_COL_W - 12;
    if (p.captain) { bx -= 20; parts.push(marke(th, bx, y + 26, 'C', th.D.gold)); bx -= 8; }
    if (p.goalkeeper) { bx -= 28; parts.push(marke(th, bx, y + 26, 'TW', th.D.accent)); }
  });

  const ty = ROSTER_TOP + perCol * ROSTER_ROW_H + 12;
  if (input.staff.length > 0 || input.footnote) {
    parts.push(`<line x1="${PAD}" y1="${ty}" x2="${WIDTH - PAD}" y2="${ty}" stroke="${th.D.text}" stroke-width="1" opacity="0.15"/>`);
  }
  if (input.staff.length > 0) {
    parts.push(`<g transform="translate(30,${ty + 12})"><rect x="0" y="4" width="18" height="22" rx="3" fill="none" stroke="${th.D.accent}" stroke-width="2"/><rect x="5" y="0" width="8" height="6" rx="2" fill="${th.D.accent}"/><line x1="4" y1="13" x2="14" y2="13" stroke="${th.D.accent}" stroke-width="2"/><line x1="4" y1="19" x2="12" y2="19" stroke="${th.D.accent}" stroke-width="2"/></g>`);
    parts.push(text(ROSTER_STAFF_X, ty + 26, 13, input.staff.length === 1 ? 'TRAINER' : 'TRAINER / BETREUER', { cond: true, weight: 600, fill: th.D.muted, ls: 2 }));
    staffZeilen.forEach((zeile, i) => {
      parts.push(text(ROSTER_STAFF_X, ty + 46 + i * ROSTER_STAFF_LINE_H, 17, zeile, { weight: 500, fill: th.D.text }));
    });
  }
  if (input.footnote) {
    // Eine eigene Zeile unter den Trainern, in voller Breite — ein Hinweis darf ausgeschrieben sein.
    const fy = staffZeilen.length > 0 ? ty + 48 + staffZeilen.length * ROSTER_STAFF_LINE_H : ty + 24;
    parts.push(text(PAD + 6, fy, 13, kuerzen(input.footnote, 13, WIDTH - 2 * PAD - 12), { fill: th.D.muted }));
  }
  fuss(th, parts, height, input.brand, true);

  parts.push('</svg>');
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Endstand und nächstes Spiel als Karte (dunkel, 800×450)
// ---------------------------------------------------------------------------

export interface ResultImageInput {
  competitionName: string;
  /** „3. Spieltag" — hinter dem Wettbewerb in der Kopfzeile. */
  subtitle?: string | null;
  /** „Sa., 26.09.2026 · 16:00" — rechts in der Kopfzeile. */
  dateLabel?: string | null;
  homeName: string;
  awayName: string;
  scoreHome: number;
  scoreAway: number;
  halftime?: { home: number; away: number } | null;
  /** Welche Seite die eigene ist — sie steht in Türkis, die andere in der Farbe ihres Logos. */
  ownIsHome: boolean;
  outcome: 'win' | 'loss' | 'draw';
  venue?: string | null;
  homeLogo?: string | null;
  awayLogo?: string | null;
  /** Farbe des Gegners aus seinem Logo (`logoAccentColor`); fehlt sie, bleibt seine Seite neutral. */
  opponentColor?: string | null;
  /** „Eskil Lieck · 12 Tore" — unten in der Mitte. */
  playerOfMatch?: string | null;
  /** „3. Sieg in Folge" — als Kapsel unten rechts. */
  streak?: string | null;
  /** „Platz 1 · 6:0 Punkte" — links in der Fußzeile. */
  standing?: string | null;
  brand?: ImageBrand | null;
  /** Die Vereinsfarben (Konfiguration); ohne Angabe die der Wölfe Voreifel. */
  palette?: Partial<HandballPalette> | null;
  /**
   * Für die Animation: der Stand, der in diesem Bild steht (hochzählend),
   * und ob Ausgang und Glanz schon gezeigt werden. Fehlt es, ist es das
   * fertige Bild.
   */
  frame?: { scoreHome: number; scoreAway: number; final: boolean } | null;
}

const CARD_LOGO_R = 66;
const CARD_LOGO_Y = 205;
/**
 * Bis zum 28.09.2026: Logos bei x = 150, Spalte 290 px, Stand 150 px hoch —
 * bei zweistelligen Ständen liefen die Ziffern in die Logokreise, und die
 * Ausgangs-Pille bzw. die Datumszeile der Spielkarte berührte die Namen der
 * Spalten. Jetzt stehen die Seiten weiter außen und schmaler, der Stand ist
 * kleiner: Ziffern ab x ≈ 230 gegen Logokreis bis 201, Spalte bis 270 gegen
 * Mittelblock ab 290 — und eine fünfte Schriftstufe (15 px), bevor gekürzt wird.
 */
const CARD_SIDE_X = 135;
const SCORE_SIZE = 128;
const TEAM_SIZE = 24;
const TEAM_COL_W = 270;

/**
 * Einen Mannschaftsnamen in die Spalte bringen: erst in einer Zeile, dann in
 * zwei an einer Wortgrenze, dann mit kleinerer Schrift — und erst zum
 * Schluss gekürzt. „HSG Siebengebirge-Thomasberg II" soll lesbar bleiben,
 * nicht „HSG / Siebengebirge-Thom…" werden.
 */
function nameInSpalte(name: string, maxWidth: number): { size: number; lines: string[] } {
  for (const size of [TEAM_SIZE, TEAM_SIZE - 3, TEAM_SIZE - 5, TEAM_SIZE - 7, TEAM_SIZE - 9]) {
    if (breite(name, size, true, true) <= maxWidth) return { size, lines: [name] };
    const woerter = name.split(' ');
    let beste: { lines: string[]; breite: number } | null = null;
    for (let i = 1; i < woerter.length; i++) {
      const a = woerter.slice(0, i).join(' ');
      const b = woerter.slice(i).join(' ');
      const w = Math.max(breite(a, size, true, true), breite(b, size, true, true));
      if (w <= maxWidth && (!beste || w < beste.breite)) beste = { lines: [a, b], breite: w };
    }
    if (beste) return { size, lines: beste.lines };
  }
  const size = TEAM_SIZE - 7;
  const woerter = name.split(' ');
  if (woerter.length === 1) return { size, lines: [kuerzen(name, size, maxWidth, true, true)] };
  let erste = '';
  for (const w of woerter) {
    const probe = erste ? `${erste} ${w}` : w;
    if (breite(probe, size, true, true) > maxWidth) break;
    erste = probe;
  }
  if (!erste) return { size, lines: [kuerzen(name, size, maxWidth, true, true)] };
  return { size, lines: [erste, kuerzen(name.slice(erste.length).trim(), size, maxWidth, true, true)] };
}

/** Beide Mannschaften mit Logo, Namen und HEIM/GAST — für Endstand und nächstes Spiel gleich. */
function beideSeiten(th: Theme, parts: string[], input: { homeName: string; awayName: string; ownIsHome: boolean; homeLogo?: string | null; awayLogo?: string | null; opponentColor?: string | null }): void {
  const gegner = input.opponentColor ?? th.D.soft;
  const seiten = [
    { x: CARD_SIDE_X, name: input.homeName, logo: input.homeLogo, own: input.ownIsHome, label: 'HEIM' },
    { x: WIDTH - CARD_SIDE_X, name: input.awayName, logo: input.awayLogo, own: !input.ownIsHome, label: 'GAST' },
  ];
  for (const s of seiten) {
    const farbe = s.own ? th.D.accent : gegner;
    parts.push(logoKreis(th, s.x, CARD_LOGO_Y, CARD_LOGO_R, s.logo, farbe, initialen(s.name)));
    const { size, lines } = nameInSpalte(s.name.toUpperCase(), TEAM_COL_W);
    lines.forEach((zeile, i) => parts.push(text(s.x, 306 + i * (size + 4), size, zeile, { cond: true, weight: 700, fill: s.own ? th.D.accent : th.D.soft, anchor: 'middle', ls: 1 })));
    parts.push(text(s.x, 306 + lines.length * (size + 4) + 2, 13, s.label, { cond: true, weight: 500, fill: th.D.muted, anchor: 'middle', ls: 3 }));
  }
}

/** Die schräge Fläche rechts in der Farbe des Gegners — zurückhaltend, sie soll färben, nicht leuchten. */
function gegnerFlaeche(th: Theme, parts: string[], farbe: string | null | undefined, ownIsHome: boolean): void {
  if (!farbe) return;
  const links = !ownIsHome;
  const punkte = links
    ? `0,0 ${WIDTH * 0.38},0 ${WIDTH * 0.52},${CARD_H} 0,${CARD_H}`
    : `${WIDTH * 0.62},0 ${WIDTH},0 ${WIDTH},${CARD_H} ${WIDTH * 0.48},${CARD_H}`;
  parts.push(`<polygon points="${punkte}" fill="${farbe}" opacity="0.18"/>`);
  const [x1, x2] = links ? [WIDTH * 0.38, WIDTH * 0.52] : [WIDTH * 0.62, WIDTH * 0.48];
  parts.push(`<line x1="${x1}" y1="0" x2="${x2}" y2="${CARD_H}" stroke="${th.D.text}" stroke-width="1" opacity="0.15"/>`);
}

/**
 * Der Endstand als Karte: der Stand riesig mit türkisem Doppelpunkt, ein
 * Glanz dahinter nur bei Sieg, beide Logos im Kreis mit Ring in der
 * jeweiligen Vereinsfarbe, Halbzeit, Ausgang als Kapsel; unten Halle,
 * Spieler des Spiels und Serie. **Keine Torschützen** — die liefert der
 * Nachrichtentext darunter, die Karte soll auf einen Blick lesbar sein.
 */
export function renderResultSvg(input: ResultImageInput): string {
  const th = themeFor(input.palette);
  const frame = input.frame ?? { scoreHome: input.scoreHome, scoreAway: input.scoreAway, final: true };
  const parts = rahmenDunkel(th, CARD_H, WIDTH / 2, CARD_H + 30, 120);
  gegnerFlaeche(th, parts, input.opponentColor, input.ownIsHome);
  parts.push(wasserzeichen(input.ownIsHome ? input.homeLogo : input.awayLogo, input.ownIsHome ? 130 : WIDTH - 130, CARD_H / 2 + 40, 230, 0.07));
  kopfDunkel(th, parts, [input.competitionName, input.subtitle, 'Endstand'].filter(Boolean).join(' · '), input.dateLabel);
  if (frame.final && input.outcome === 'win') parts.push(`<ellipse cx="${WIDTH / 2}" cy="215" rx="230" ry="130" fill="url(#glow)"/>`);
  beideSeiten(th, parts, input);

  parts.push(text(WIDTH / 2 - 22, 262, SCORE_SIZE, String(frame.scoreHome), { cond: true, weight: 700, fill: th.D.text, anchor: 'end' }));
  parts.push(text(WIDTH / 2, 252, 110, ':', { cond: true, weight: 700, fill: th.D.accent, anchor: 'middle' }));
  parts.push(text(WIDTH / 2 + 22, 262, SCORE_SIZE, String(frame.scoreAway), { cond: true, weight: 700, fill: th.D.text, anchor: 'start' }));
  if (input.halftime && frame.final) {
    parts.push(text(WIDTH / 2, 296, 20, `HALBZEIT ${input.halftime.home}:${input.halftime.away}`, { cond: true, weight: 500, fill: th.D.soft, anchor: 'middle', ls: 2 }));
  }
  if (frame.final) {
    const label = input.outcome === 'win' ? 'SIEG' : input.outcome === 'loss' ? 'NIEDERLAGE' : 'UNENTSCHIEDEN';
    const fill = input.outcome === 'win' ? th.D.accent : input.outcome === 'loss' ? th.D.text : th.D.soft;
    parts.push(pille(WIDTH / 2, 333, label, fill, th.D.bg0));
  }

  parts.push(`<line x1="${PAD}" y1="378" x2="${WIDTH - PAD}" y2="378" stroke="${th.D.text}" stroke-width="1" opacity="0.15"/>`);
  let x = PAD + 10;
  if (input.venue) {
    parts.push(`<circle cx="${x}" cy="400" r="4" fill="${th.D.accent}"/>`);
    const halleText = kuerzen(input.venue, 15, 260);
    parts.push(text(x + 12, 405, 15, halleText, { fill: th.D.soft }));
    x += 12 + breite(halleText, 15) + 28;
  }
  if (input.playerOfMatch && frame.final) {
    parts.push(`<circle cx="${x}" cy="400" r="4" fill="${th.D.gold}"/>`);
    parts.push(text(x + 12, 405, 15, kuerzen(`Spieler des Spiels: ${input.playerOfMatch}`, 15, (input.streak ? WIDTH - 190 : WIDTH - PAD) - x - 12), { fill: th.D.soft }));
  }
  if (input.streak && frame.final) {
    const label = input.streak.toUpperCase();
    const w = breite(label, 14, true, true) + 28;
    parts.push(`<rect x="${WIDTH - PAD - w}" y="388" width="${w}" height="24" rx="12" fill="${th.D.text}" opacity="0.1"/>`);
    parts.push(text(WIDTH - PAD - w / 2, 405, 14, label, { cond: true, weight: 600, fill: th.D.accent, anchor: 'middle', ls: 1.5 }));
  }
  fuss(th, parts, CARD_H, input.brand, true, input.standing);
  parts.push('</svg>');
  return parts.join('');
}

export interface FixtureImageInput {
  competitionName: string;
  /** „4. Spieltag" oder null. */
  subtitle?: string | null;
  homeName: string;
  awayName: string;
  ownIsHome: boolean;
  /** „Sa., 03.10.2026" und „14:45 Uhr" — getrennt, weil beide groß stehen. */
  dateLabel: string;
  timeLabel: string;
  venue?: string | null;
  homeLogo?: string | null;
  awayLogo?: string | null;
  opponentColor?: string | null;
  brand?: ImageBrand | null;
  /** Die Vereinsfarben (Konfiguration); ohne Angabe die der Wölfe Voreifel. */
  palette?: Partial<HandballPalette> | null;
}

/** Das nächste Spiel als Karte: beide Logos, „VS", Datum und Anwurf groß, die Halle darunter. */
export function renderFixtureSvg(input: FixtureImageInput): string {
  const th = themeFor(input.palette);
  const parts = rahmenDunkel(th, CARD_H, WIDTH / 2, CARD_H + 30, 120);
  gegnerFlaeche(th, parts, input.opponentColor, input.ownIsHome);
  parts.push(wasserzeichen(input.ownIsHome ? input.homeLogo : input.awayLogo, input.ownIsHome ? 130 : WIDTH - 130, CARD_H / 2 + 40, 230, 0.07));
  kopfDunkel(th, parts, [input.competitionName, input.subtitle, 'Nächstes Spiel'].filter(Boolean).join(' · '), null);
  beideSeiten(th, parts, input);
  parts.push(text(WIDTH / 2, 236, 96, 'VS', { cond: true, weight: 700, fill: th.D.accent, anchor: 'middle', ls: 4 }));
  parts.push(text(WIDTH / 2, 290, 30, input.dateLabel.toUpperCase(), { cond: true, weight: 700, fill: th.D.text, anchor: 'middle', ls: 1.5 }));
  parts.push(text(WIDTH / 2, 322, 24, `ANWURF ${input.timeLabel.toUpperCase()}`, { cond: true, weight: 500, fill: th.D.soft, anchor: 'middle', ls: 2 }));
  parts.push(pille(WIDTH / 2, 360, input.ownIsHome ? 'HEIMSPIEL' : 'AUSWÄRTS', th.D.text, th.D.bg0, 15));
  parts.push(`<line x1="${PAD}" y1="378" x2="${WIDTH - PAD}" y2="378" stroke="${th.D.text}" stroke-width="1" opacity="0.15"/>`);
  if (input.venue) {
    parts.push(`<circle cx="${PAD + 10}" cy="400" r="4" fill="${th.D.accent}"/>`);
    parts.push(text(PAD + 22, 405, 15, kuerzen(input.venue, 15, WIDTH - 2 * PAD - 30), { fill: th.D.soft }));
  }
  fuss(th, parts, CARD_H, input.brand, true);
  parts.push('</svg>');
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Saisonabschluss als Karte (dunkel, 800×450)
// ---------------------------------------------------------------------------

export interface SeasonSummaryInput {
  teamName: string;
  competitionName: string;
  /** „B-Jugend · Saison 2026/27" — rechts in der Kopfzeile. */
  subtitle?: string | null;
  /** Endplatz und Zahl der Mannschaften der Staffel; ohne Tabelle null. */
  position: number | null;
  teams: number | null;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
  /** „Eskil Lieck · 87 Tore" — null ohne gespeicherte Aufstellung. */
  topScorer?: string | null;
  /** „34:19 gegen HV Erftstadt" — null ohne Sieg. */
  biggestWin?: string | null;
  /** Tabellenplatz je Spieltag (aufsteigend) für die kleine Kurve; leer heißt keine Kurve. */
  positions?: Array<{ round: number; position: number }> | null;
  logo?: string | null;
  brand?: ImageBrand | null;
  palette?: Partial<HandballPalette> | null;
  /**
   * Mitten in der Saison: „Zwischenbilanz" statt „Saisonbilanz", „Platz" statt
   * „Endplatz" und keine Meister-Pille — Platz 1 nach drei Spieltagen ist eine
   * Tabellenführung, kein Titel. Fehlt das Feld, gilt die Karte als Abschluss.
   */
  zwischenstand?: boolean;
}

/**
 * Die Saison als Karte: Endplatz groß, Bilanz S-U-N, Tore und Punkte als
 * Kacheln, Torschützenkönig und höchster Sieg als Zeilen, der Tabellenplatz-
 * Verlauf klein rechts — dieselbe Optik wie die Endstand-Karte, damit sie in
 * der Serie steht. Geschickt einmal, wenn das letzte Spiel der Saison durch
 * ist (`saisonVorbei` in lib/handballBot.ts).
 */
export function renderSeasonSummarySvg(input: SeasonSummaryInput): string {
  const th = themeFor(input.palette);
  const parts = rahmenDunkel(th, CARD_H, 130, CARD_H + 40, 120);
  parts.push(wasserzeichen(input.logo, WIDTH - 130, CARD_H / 2 + 30, 230, 0.07));
  const zwischen = input.zwischenstand === true;
  kopfDunkel(th, parts, [input.competitionName, zwischen ? 'Zwischenbilanz' : 'Saisonbilanz'].join(' · '), input.subtitle);

  // Links: Logo, Mannschaft, Endplatz.
  parts.push(logoKreis(th, 82, 132, 44, input.logo, th.D.accent, initialen(input.teamName)));
  const { size, lines } = nameInSpalte(input.teamName.toUpperCase(), 300);
  lines.forEach((zeile, i) => parts.push(text(146, 120 + i * (size + 4), size, zeile, { cond: true, weight: 700, fill: th.D.text, ls: 1 })));
  const spiele = input.won + input.drawn + input.lost;
  parts.push(text(146, 120 + lines.length * (size + 4) + 2, 13, `${spiele} SPIELE`, { cond: true, weight: 500, fill: th.D.muted, ls: 3 }));

  if (input.position !== null) {
    parts.push(text(PAD + 6, 292, 26, zwischen ? 'PLATZ' : 'ENDPLATZ', { cond: true, weight: 600, fill: th.D.accent, ls: 3 }));
    parts.push(text(PAD + 4, 372, 96, `${input.position}.`, { cond: true, weight: 700, fill: th.D.text }));
    if (input.teams) parts.push(text(PAD + 4 + breite(`${input.position}.`, 96, true, true) + 12, 372, 22, `von ${input.teams}`, { cond: true, weight: 500, fill: th.D.soft, ls: 1 }));
    if (input.position === 1) parts.push(pille(PAD + 70, 402, zwischen ? 'TABELLENFÜHRER' : 'MEISTER', th.D.gold, th.D.bg0, 14));
  } else {
    parts.push(text(PAD + 6, 292, 26, 'SAISON', { cond: true, weight: 600, fill: th.D.accent, ls: 3 }));
    parts.push(text(PAD + 4, 372, 96, `${input.won}-${input.drawn}-${input.lost}`, { cond: true, weight: 700, fill: th.D.text }));
  }

  // Mitte: drei Kacheln — Bilanz, Tore, Punkte.
  const kachelX = 330;
  const kachelW = 120;
  const kacheln = [
    { label: 'S-U-N', wert: `${input.won}-${input.drawn}-${input.lost}` },
    { label: 'TORE', wert: `${input.goalsFor}:${input.goalsAgainst}` },
    { label: 'PUNKTE', wert: `${input.points}:${Math.max(0, spiele * 2 - input.points)}` },
  ];
  kacheln.forEach((k, i) => {
    const x = kachelX + i * (kachelW + 10);
    parts.push(`<rect x="${x}" y="96" width="${kachelW}" height="74" rx="8" fill="${th.D.text}" opacity="0.06"/>`);
    parts.push(text(x + kachelW / 2, 120, 12, k.label, { cond: true, weight: 600, fill: th.D.muted, anchor: 'middle', ls: 2 }));
    const gross = breite(k.wert, 34, true, true) <= kachelW - 16 ? 34 : 26;
    parts.push(text(x + kachelW / 2, 158, gross, k.wert, { cond: true, weight: 700, fill: th.D.text, anchor: 'middle' }));
  });

  // Rechts unten: der Verlauf klein, Platz 1 oben.
  const pts = [...(input.positions ?? [])].sort((a, b) => a.round - b.round);
  const vx0 = kachelX;
  const vx1 = WIDTH - PAD;
  const vy0 = 196;
  const vh = 118;
  if (pts.length >= 2) {
    const teams = Math.max(2, input.teams ?? 0, ...pts.map(p => p.position));
    const xVon = (i: number) => vx0 + (i / (pts.length - 1)) * (vx1 - vx0);
    const yVon = (platz: number) => vy0 + ((platz - 1) / (teams - 1)) * vh;
    parts.push(text(vx0, vy0 - 8, 12, 'TABELLENPLATZ JE SPIELTAG', { cond: true, weight: 600, fill: th.D.muted, ls: 2 }));
    parts.push(`<line x1="${vx0}" y1="${vy0}" x2="${vx1}" y2="${vy0}" stroke="${th.D.text}" stroke-width="1" opacity="0.12"/>`);
    parts.push(`<line x1="${vx0}" y1="${vy0 + vh}" x2="${vx1}" y2="${vy0 + vh}" stroke="${th.D.text}" stroke-width="1" opacity="0.12"/>`);
    parts.push(text(vx1, vy0 + 4, 10, '1.', { cond: true, fill: th.D.muted, anchor: 'end' }));
    parts.push(text(vx1, vy0 + vh + 4, 10, `${teams}.`, { cond: true, fill: th.D.muted, anchor: 'end' }));
    const xy = pts.map((p, i) => ({ x: xVon(i), y: yVon(p.position) }));
    parts.push(`<path d="${kurve(xy)}" fill="none" stroke="${th.D.accent}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`);
    const letzter = xy[xy.length - 1];
    parts.push(`<circle cx="${letzter.x}" cy="${letzter.y}" r="7" fill="${th.D.accent}"/>`);
    parts.push(`<circle cx="${xy[0].x}" cy="${xy[0].y}" r="4" fill="${th.D.soft}"/>`);
  }

  // Unten: Torschützenkönig und höchster Sieg.
  parts.push(`<line x1="${kachelX}" y1="342" x2="${WIDTH - PAD}" y2="342" stroke="${th.D.text}" stroke-width="1" opacity="0.15"/>`);
  let zy = 368;
  if (input.topScorer) {
    parts.push(`<circle cx="${kachelX + 6}" cy="${zy - 5}" r="4" fill="${th.D.gold}"/>`);
    parts.push(text(kachelX + 18, zy, 15, kuerzen(`Torschützenkönig: ${input.topScorer}`, 15, WIDTH - PAD - kachelX - 18), { fill: th.D.soft }));
    zy += 26;
  }
  if (input.biggestWin) {
    parts.push(`<circle cx="${kachelX + 6}" cy="${zy - 5}" r="4" fill="${th.D.accent}"/>`);
    parts.push(text(kachelX + 18, zy, 15, kuerzen(`Höchster Sieg: ${input.biggestWin}`, 15, WIDTH - PAD - kachelX - 18), { fill: th.D.soft }));
  }
  fuss(th, parts, CARD_H, input.brand, true);
  parts.push('</svg>');
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Diagramme (hell): Tabellenplatz-Verlauf, Torjäger, Spielerentwicklung
// ---------------------------------------------------------------------------

export interface PositionChartInput {
  teamName: string;
  subtitle?: string | null;
  logo?: string | null;
  /** Ein Punkt je gespieltem Spieltag, aufsteigend; `teams` ist die Zahl der Mannschaften in der Staffel. */
  points: Array<{ round: number; position: number; points: number; teams: number }>;
  /** Wie viele Spieltage die Saison hat, wenn bekannt — die Achse reicht dann bis dahin, sonst bis zum letzten Punkt. */
  totalRounds?: number | null;
  /** Der nächste Gegner — sein Logo steht am nächsten Spieltag, gestrichelt angebunden. */
  nextOpponent?: { name: string; logo?: string | null } | null;
  brand?: ImageBrand | null;
  /** Die Vereinsfarben (Konfiguration); ohne Angabe die der Wölfe Voreifel. */
  palette?: Partial<HandballPalette> | null;
}

const CHART_H = 300;
const AXIS_LEFT = PAD + 34;
const AXIS_BOTTOM_LABELS = 76;

/** Weiche Kurve durch die Punkte (Catmull-Rom → kubische Bézier), damit ein Platzwechsel nicht wie ein Knick aussieht. */
function kurve(pts: Array<{ x: number; y: number }>): string {
  if (pts.length < 2) return '';
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

/**
 * Der Tabellenplatz je Spieltag als Kurve: Platz 1 oben, die Zahl der
 * Mannschaften unten, eine Fläche unter der Kurve, der aktuelle Punkt mit
 * Glanz, bester und schlechtester Platz beschriftet. Unter der Achse die
 * Punkte je Spieltag als kleine Balken — so sieht man, ob ein Sprung von
 * einem Sieg kommt oder vom Spielplan.
 */
export function renderPositionChartSvg(input: PositionChartInput): string {
  const th = themeFor(input.palette);
  const pts = [...input.points].sort((a, b) => a.round - b.round);
  const top = PAD + TITLE_SIZE + (input.subtitle ? SUB_SIZE + 10 : 0) + 18;
  const height = top + CHART_H + AXIS_BOTTOM_LABELS + (input.brand ? FUSS_H : 0) + PAD;
  const parts = rahmenHell(th, height);
  kopfHell(th, parts, input.teamName, input.subtitle, input.logo);

  const teams = Math.max(2, ...pts.map(p => p.teams), ...pts.map(p => p.position));
  const letzteRunde = Math.max(1, ...pts.map(p => p.round));
  const runden = Math.max(letzteRunde, input.totalRounds ?? 0, input.nextOpponent ? letzteRunde + 1 : 1, 1);
  const x0 = AXIS_LEFT;
  const x1 = WIDTH - PAD;
  const bandH = CHART_H / teams;
  const inset = 18;
  const xVon = (runde: number) => runden === 1 ? (x0 + x1) / 2 : x0 + inset + ((runde - 1) / (runden - 1)) * (x1 - x0 - 2 * inset);
  const yVon = (platz: number) => top + (platz - 0.5) * bandH;
  const unten = top + CHART_H;

  for (let platz = 1; platz <= teams; platz++) {
    const y = top + (platz - 1) * bandH;
    const fill = platz <= 3 ? th.L.own : platz % 2 === 0 ? th.L.zebra : th.L.background;
    parts.push(`<rect x="${x0}" y="${y}" width="${x1 - x0}" height="${bandH}" fill="${fill}"/>`);
    parts.push(`<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${th.L.line}" stroke-width="1"/>`);
    parts.push(text(x0 - 8, yVon(platz) + 5, 14, `${platz}.`, { cond: true, weight: 500, fill: th.L.muted, anchor: 'end' }));
  }
  parts.push(`<line x1="${x0}" y1="${unten}" x2="${x1}" y2="${unten}" stroke="${th.L.line}" stroke-width="1"/>`);

  const schritt = runden > 12 ? 2 : 1;
  for (let r = 1; r <= runden; r++) {
    const x = xVon(r);
    parts.push(`<line x1="${x}" y1="${unten}" x2="${x}" y2="${unten + 4}" stroke="${th.L.line}" stroke-width="1"/>`);
    if ((r - 1) % schritt === 0) parts.push(text(x, unten + 18, 13, `${r}.`, { cond: true, weight: 500, fill: r <= letzteRunde ? th.L.text : th.L.muted, anchor: 'middle' }));
  }

  const xy = pts.map(p => ({ x: xVon(p.round), y: yVon(p.position) }));
  if (pts.length > 1) {
    const d = kurve(xy);
    parts.push(`<path d="${d} L${xy[xy.length - 1].x.toFixed(1)},${unten} L${xy[0].x.toFixed(1)},${unten} Z" fill="url(#flaeche)"/>`);
    parts.push(`<path d="${d}" fill="none" stroke="${th.L.ownBar}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>`);
    parts.push(`<path d="${d}" fill="none" stroke="${th.L.header}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  // Punkte je Spieltag als kleine Balken unter der Achse.
  const maxPunkte = Math.max(1, ...pts.map(p => p.points));
  pts.forEach((p, i) => {
    const { x, y } = xy[i];
    const letzter = i === pts.length - 1;
    if (letzter) parts.push(`<circle cx="${x}" cy="${y}" r="24" fill="${th.L.ownBar}" opacity="0.25"/>`);
    parts.push(`<circle cx="${x}" cy="${y}" r="13" fill="${th.L.header}" stroke="${th.L.ownBar}" stroke-width="3"/>`);
    parts.push(text(x, y + 5, 14, String(p.position), { cond: true, weight: 700, fill: th.L.headerText, anchor: 'middle' }));
    const bh = Math.max(3, Math.round((p.points / maxPunkte) * 16));
    parts.push(`<rect x="${x - 7}" y="${unten + 26 + (16 - bh)}" width="14" height="${bh}" rx="2" fill="${th.L.ownBar}"/>`);
    parts.push(text(x, unten + 54, 11, `${p.points} Pkt`, { cond: true, weight: 500, fill: th.L.accent, anchor: 'middle' }));
  });
  if (pts.length > 2) {
    // Bestwert und Tiefstwert als Zeile unter der Achse — am Punkt selbst liefe die Schrift in die Kurve.
    const best = pts.reduce((a, b) => (b.position < a.position ? b : a));
    const worst = pts.reduce((a, b) => (b.position > a.position ? b : a));
    if (best.position !== worst.position) {
      parts.push(text(x1, unten + 72, 12, `Bestwert Platz ${best.position} (${best.round}. Spieltag) · Tiefstwert Platz ${worst.position} (${worst.round}. Spieltag)`, { cond: true, weight: 500, fill: th.L.muted, anchor: 'end', ls: 0.5 }));
    }
  }
  if (input.nextOpponent && pts.length > 0 && letzteRunde + 1 <= runden) {
    const von = xy[xy.length - 1];
    const x = xVon(letzteRunde + 1);
    parts.push(`<line x1="${von.x}" y1="${von.y}" x2="${x}" y2="${von.y}" stroke="${th.L.muted}" stroke-width="1.5" stroke-dasharray="5 4"/>`);
    const id = `no${++clipZaehler}`;
    if (input.nextOpponent.logo) {
      parts.push(`<clipPath id="${id}"><circle cx="${x}" cy="${von.y}" r="13"/></clipPath>`);
      parts.push(`<circle cx="${x}" cy="${von.y}" r="15" fill="#ffffff" stroke="${COLOR_NEXT_BAR}" stroke-width="2"/>`);
      parts.push(`<image href="${input.nextOpponent.logo}" x="${x - 13}" y="${von.y - 13}" width="26" height="26" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>`);
    } else {
      parts.push(`<circle cx="${x}" cy="${von.y}" r="15" fill="${COLOR_NEXT}" stroke="${COLOR_NEXT_BAR}" stroke-width="2"/>`);
      parts.push(text(x, von.y + 4, 10, initialen(input.nextOpponent.name), { cond: true, weight: 700, fill: th.L.muted, anchor: 'middle' }));
    }
    parts.push(text(x, von.y - 22, 11, 'nächster Gegner', { cond: true, weight: 600, fill: COLOR_NEXT_BAR, anchor: 'middle', ls: 1 }));
  }
  if (pts.length === 0) parts.push(text((x0 + x1) / 2, top + CHART_H / 2, 15, 'Noch kein Spieltag gespielt', { fill: th.L.muted, anchor: 'middle' }));
  if (input.brand) fuss(th, parts, height, input.brand, false);

  parts.push('</svg>');
  return parts.join('');
}

export interface ScorersImageInput {
  teamName: string;
  subtitle?: string | null;
  logo?: string | null;
  /** Bereits sortiert (Tore absteigend); höchstens die ersten zwölf werden gezeichnet. */
  scorers: Array<{ name: string; number: number; goals: number; sevenMeterGoals: number; games: number }>;
  /** Alle Tore der Mannschaft in der Saison — für den Anteil je Spieler. */
  totalGoals: number;
  brand?: ImageBrand | null;
  /** Die Vereinsfarben (Konfiguration); ohne Angabe die der Wölfe Voreifel. */
  palette?: Partial<HandballPalette> | null;
}

const SCORER_ROW_H = 36;
const SCORER_MAX = 12;
/**
 * Die Namensspalte: mindestens 190 px, sonst so breit, wie der längste Name
 * braucht — bis zu 300 px, dann bleibt dem Balken noch die Hälfte des Bilds.
 * Bis zum 28.09.2026 waren es feste 190 px, und „Tillmann Imre Standfuß"
 * stand als „Tillmann Imre Sta…" im Bild.
 */
const SCORER_NAME_W_MIN = 190;
const SCORER_NAME_W_MAX = 300;
const SCORER_RIGHT_W = 124;
/** Platz für die Torzahl hinter dem längsten Balken. */
const SCORER_VALUE_W = 44;

/**
 * Die Torjäger als Balken: Länge nach Toren, der Siebenmeter-Anteil als
 * dunkleres Stück am Anfang, rechts Tore und Anteil an allen Toren. Zwölf
 * Zeilen sind das Maximum — darunter fängt die Liste an, wie ein Kader
 * auszusehen, und der Balken sagt nichts mehr.
 */
export function renderScorersSvg(input: ScorersImageInput): string {
  const th = themeFor(input.palette);
  const scorers = input.scorers.filter(s => s.goals > 0).slice(0, SCORER_MAX);
  const top = PAD + TITLE_SIZE + (input.subtitle ? SUB_SIZE + 10 : 0) + 18;
  const fussH = FOOT_SIZE + 14;
  const height = top + Math.max(1, scorers.length) * SCORER_ROW_H + fussH + (input.brand ? FUSS_H : 0) + PAD;
  const parts = rahmenHell(th, height);
  kopfHell(th, parts, input.teamName, input.subtitle, input.logo);

  const maxTore = Math.max(1, ...scorers.map(s => s.goals));
  const laengster = Math.max(0, ...scorers.map(s => estimateTextWidth(s.name, ROW_SIZE)));
  const nameW = Math.min(SCORER_NAME_W_MAX, Math.max(SCORER_NAME_W_MIN, Math.ceil(laengster) + 14));
  const barX = PAD + 30 + nameW;
  const barMax = WIDTH - PAD - SCORER_RIGHT_W - SCORER_VALUE_W - barX;
  scorers.forEach((s, i) => {
    const y = top + i * SCORER_ROW_H;
    const ty = y + SCORER_ROW_H / 2 + ROW_SIZE / 2 - 3;
    if (i % 2 === 1) parts.push(`<rect x="${PAD}" y="${y}" width="${WIDTH - 2 * PAD}" height="${SCORER_ROW_H}" fill="${th.L.zebra}"/>`);
    parts.push(text(PAD + 22, ty, ROW_SIZE + 1, `${i + 1}.`, { cond: true, weight: 700, fill: th.L.accent, anchor: 'end' }));
    parts.push(text(PAD + 30, ty, ROW_SIZE, truncateToWidth(s.name, ROW_SIZE, nameW - 10, false)));
    const w = Math.max(4, Math.round((s.goals / maxTore) * barMax));
    parts.push(`<rect x="${barX}" y="${y + 8}" width="${w}" height="${SCORER_ROW_H - 16}" rx="4" fill="${th.L.ownBar}"/>`);
    if (s.sevenMeterGoals > 0) {
      const w7 = Math.max(2, Math.round((s.sevenMeterGoals / maxTore) * barMax));
      parts.push(`<rect x="${barX}" y="${y + 8}" width="${Math.min(w, w7)}" height="${SCORER_ROW_H - 16}" rx="4" fill="${th.L.header}"/>`);
    }
    const anteil = input.totalGoals > 0 ? Math.round((s.goals / input.totalGoals) * 100) : 0;
    parts.push(text(barX + w + 8, ty, ROW_SIZE + 2, String(s.goals), { cond: true, weight: 700, fill: th.L.header }));
    parts.push(text(WIDTH - PAD, ty, 13, `${anteil} % · ${s.games} Sp.`, { fill: th.L.muted, anchor: 'end' }));
  });
  if (scorers.length === 0) parts.push(text(PAD, top + SCORER_ROW_H / 2 + 6, ROW_SIZE, 'Noch kein Tor gespeichert', { fill: th.L.muted }));

  const fy = top + Math.max(1, scorers.length) * SCORER_ROW_H + FOOT_SIZE + 6;
  parts.push(`<rect x="${PAD}" y="${fy - 10}" width="12" height="10" rx="2" fill="${th.L.header}"/>`);
  parts.push(text(PAD + 18, fy, FOOT_SIZE, `davon Siebenmeter · ${input.totalGoals} Tore insgesamt`, { fill: th.L.muted }));
  if (input.brand) fuss(th, parts, height, input.brand, false);

  parts.push('</svg>');
  return parts.join('');
}
const FOOT_SIZE = 13;

export interface PlayerChartInput {
  name: string;
  number: number;
  teamName: string;
  subtitle?: string | null;
  logo?: string | null;
  /** Ein Balken je Spiel, chronologisch: Gegner (Name und Logo), Datum kurz, Tore. */
  games: Array<{ opponent: string; dateLabel: string; goals: number; isHome: boolean; logo?: string | null }>;
  brand?: ImageBrand | null;
  /** Die Vereinsfarben (Konfiguration); ohne Angabe die der Wölfe Voreifel. */
  palette?: Partial<HandballPalette> | null;
}

const PLAYER_CHART_H = 220;
const PLAYER_LABEL_H = 50;
const PLAYER_LOGO = 28;

/**
 * Tore je Spiel eines Spielers als Balken, mit dem Schnitt als gestrichelter
 * Linie. Unter dem Balken das Logo des Gegners, wo eines da ist, sonst sein
 * Name; ein Heimspiel heißt „gg.", ein Auswärtsspiel „bei".
 */
export function renderPlayerChartSvg(input: PlayerChartInput): string {
  const th = themeFor(input.palette);
  const games = input.games;
  const mitLogo = games.some(g => g.logo);
  const labelH = PLAYER_LABEL_H + (mitLogo ? PLAYER_LOGO + 8 : 0);
  const top = PAD + TITLE_SIZE + (input.subtitle ? SUB_SIZE + 10 : 0) + 18;
  const height = top + PLAYER_CHART_H + labelH + (input.brand ? FUSS_H : 0) + PAD;
  const parts = rahmenHell(th, height);
  kopfHell(th, parts, `${input.name} (Nr. ${input.number})`, input.subtitle, input.logo);

  const x0 = AXIS_LEFT;
  const x1 = WIDTH - PAD;
  const maxTore = Math.max(1, ...games.map(g => g.goals));
  const skala = maxTore <= 5 ? 5 : Math.ceil(maxTore / 5) * 5;
  const yVon = (tore: number) => top + PLAYER_CHART_H - (tore / skala) * PLAYER_CHART_H;
  for (let t = 0; t <= skala; t += skala <= 5 ? 1 : Math.ceil(skala / 5)) {
    const y = yVon(t);
    parts.push(`<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${th.L.line}" stroke-width="1"/>`);
    parts.push(text(x0 - 8, y + 4, 13, String(t), { cond: true, weight: 500, fill: th.L.muted, anchor: 'end' }));
  }
  const slot = games.length > 0 ? (x1 - x0) / games.length : x1 - x0;
  const barW = Math.min(64, Math.max(10, slot * 0.6));
  const unten = top + PLAYER_CHART_H;
  games.forEach((g, i) => {
    const cx = x0 + slot * (i + 0.5);
    const y = yVon(g.goals);
    const h = unten - y;
    parts.push(`<rect x="${cx - barW / 2}" y="${y}" width="${barW}" height="${Math.max(0, h)}" rx="4" fill="${g.goals > 0 ? th.L.ownBar : th.L.line}"/>`);
    parts.push(text(cx, y - 6, 16, String(g.goals), { cond: true, weight: 700, fill: th.L.header, anchor: 'middle' }));
    let ly = unten + 16;
    if (mitLogo) {
      const lcy = unten + 8 + PLAYER_LOGO / 2;
      if (g.logo) {
        const id = `pl${++clipZaehler}`;
        parts.push(`<clipPath id="${id}"><circle cx="${cx}" cy="${lcy}" r="${PLAYER_LOGO / 2}"/></clipPath>`);
        parts.push(`<circle cx="${cx}" cy="${lcy}" r="${PLAYER_LOGO / 2}" fill="#ffffff" stroke="${th.L.line}" stroke-width="1"/>`);
        parts.push(`<image href="${g.logo}" x="${cx - PLAYER_LOGO / 2}" y="${lcy - PLAYER_LOGO / 2}" width="${PLAYER_LOGO}" height="${PLAYER_LOGO}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>`);
      } else {
        parts.push(`<circle cx="${cx}" cy="${lcy}" r="${PLAYER_LOGO / 2}" fill="${th.L.zebra}" stroke="${th.L.line}" stroke-width="1"/>`);
        parts.push(text(cx, lcy + 4, 10, initialen(g.opponent), { cond: true, weight: 700, fill: th.L.muted, anchor: 'middle' }));
      }
      ly += PLAYER_LOGO + 8;
    }
    const gegner = truncateToWidth(`${g.isHome ? 'gg.' : 'bei'} ${g.opponent}`, 11, Math.max(30, slot - 6), false);
    parts.push(text(cx, ly, 11, gegner, { fill: th.L.text, anchor: 'middle' }));
    parts.push(text(cx, ly + 16, 11, g.dateLabel, { fill: th.L.muted, anchor: 'middle' }));
  });
  if (games.length > 0) {
    const schnitt = games.reduce((a, g) => a + g.goals, 0) / games.length;
    const y = yVon(schnitt);
    parts.push(`<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${th.L.header}" stroke-width="2" stroke-dasharray="6 5"/>`);
    parts.push(text(x1, y - 5, 13, `Ø ${schnitt.toFixed(1).replace('.', ',')}`, { cond: true, weight: 700, fill: th.L.header, anchor: 'end' }));
  } else {
    parts.push(text((x0 + x1) / 2, top + PLAYER_CHART_H / 2, 15, 'Noch kein Spiel gespeichert', { fill: th.L.muted, anchor: 'middle' }));
  }
  if (input.brand) fuss(th, parts, height, input.brand, false);

  parts.push('</svg>');
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Rastern
// ---------------------------------------------------------------------------

/** Doppelt gerastert (1600 px breit), damit es auf dem Telefon scharf bleibt. */
export async function renderPng(svg: string, scale = 2): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: 72 * scale })
    .resize({ width: WIDTH * scale })
    .flatten({ background: '#ffffff' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Dasselbe als JPEG — für den Inline-Modus des Bots, dessen Ergebnisse
 * Telegram selbst von einer URL holt und dort nur JPEG annimmt
 * (`InlineQueryResultPhoto.photo_url`). `scale` unter 1 ergibt das
 * Vorschaubild.
 */
export async function renderJpeg(svg: string, scale = 2): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: Math.max(18, Math.round(72 * scale)) })
    .resize({ width: Math.round(WIDTH * scale) })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

/**
 * Mehrere Bilder gleicher Größe als GIF hintereinander — die Bilder hoch
 * gestapelt, `pageHeight` trennt sie wieder (derselbe Weg wie bei den
 * Tecki-Stickern). GIF statt animiertem WebP, weil Telegram nur GIF oder
 * MP4 als Animation annimmt. Einfach gerastert (800 px): Ein GIF hat 256
 * Farben, doppelt so groß hieße viermal so viele Bytes für nichts.
 */
export async function renderGif(frames: string[], opts: { delayMs: number; holdLastMs: number }): Promise<Buffer> {
  if (frames.length === 0) throw new Error('renderGif: keine Bilder');
  const bilder: Buffer[] = [];
  let width = 0; let height = 0;
  for (const svg of frames) {
    const { data, info } = await sharp(Buffer.from(svg), { density: 72 }).resize({ width: WIDTH }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    width = info.width; height = info.height;
    bilder.push(data);
  }
  const delay = frames.map((_, i) => (i === frames.length - 1 ? opts.holdLastMs : opts.delayMs));
  return sharp(Buffer.concat(bilder), { raw: { width, height: height * frames.length, channels: 4, pageHeight: height } })
    .gif({ delay, loop: 0, effort: 7 })
    .toBuffer();
}

/**
 * Die Vereinsfarbe aus einem Logo: die häufigste gesättigte Farbe, Weiß,
 * Grau und Schwarz ignoriert — bei einem schwarz-weißen Wappen bleibt es
 * bei null, und die Karte färbt die Gegnerseite nicht.
 */
export async function logoAccentColor(dataUri: string | null | undefined): Promise<string | null> {
  if (!dataUri) return null;
  const komma = dataUri.indexOf(',');
  if (komma < 0) return null;
  let data: Buffer; let channels: number;
  try {
    const out = await sharp(Buffer.from(dataUri.slice(komma + 1), 'base64')).resize(48, 48, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
    data = out.data; channels = out.info.channels;
  } catch {
    return null;
  }
  const zaehl = new Map<string, number>();
  for (let i = 0; i + 2 < data.length; i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    if (sat < 0.35 || max < 50) continue;
    const k = `${r >> 4},${g >> 4},${b >> 4}`;
    zaehl.set(k, (zaehl.get(k) ?? 0) + 1);
  }
  const best = [...zaehl.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 8) return null;
  const [r, g, b] = best[0].split(',').map(n => (Number(n) << 4) + 8);
  return `#${[r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')}`;
}

/** Nur zur Sicherheit für Aufrufer, die die geschätzte Breite prüfen wollen. */
export const __nameMaxWidthForTests = { NAME_MAX_WIDTH, ROSTER_NAME_MAX_WIDTH, ROW_SIZE, estimateTextWidth };
