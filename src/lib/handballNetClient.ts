/**
 * Client für die interne Schnittstelle von handball.net (docs/handball-verfolgung.md).
 *
 * handball.net ist die Plattform des Deutschen Handballbundes und führt jede
 * Kreisliga bis hinunter zur Jugend — das, was keine der geprüften Sport-APIs
 * hat (§2 der Doku). Eine dokumentierte Schnittstelle gibt es nicht; die
 * Web-App der Seite spricht mit `/api/new/…`, und genau das wird hier
 * nachgebaut. Drei Dinge, die man dafür wissen muss:
 *
 * 1. **Der Handschlag.** Die Seite legt in jede HTML-Antwort ein
 *    `<meta name="client-token">`, und die API verlangt es als Header
 *    `x-client-token` — dazu eine Browser-Kennung und einen Referer, sonst
 *    kommt 403 mit `{"error":"Forbidden"}`. Der Wert trägt vorn einen
 *    Millisekunden-Zeitstempel rund zwölf Stunden in der Zukunft, also
 *    vermutlich sein Ablauf; die App lädt die Seite bei
 *    `CLIENT_TOKEN_EXPIRED` neu. Hier wird das Token zehn Minuten behalten
 *    und bei 401/403 einmal frisch geholt.
 *
 * 2. **Die Uhrzeiten sind Ortszeit mit falschem Etikett.** `date` steht als
 *    `2026-09-26T15:30:00+00:00`, gemeint ist 15:30 Uhr in Deutschland.
 *    Beleg vom 26.09.2026: Das Spiel war um 15:19 UTC (laut `meta.timestamp`
 *    der Antwort, der echte Serverzeit trägt) längst beendet, samt
 *    Spielbericht — und die Aufstellung wurde um „15:28:14+00:00" gemeldet,
 *    zwei Minuten vor einem Anwurf, der bei wörtlicher Lesart erst 17:30 Uhr
 *    gewesen wäre. `sourceTimeToUtc` liest deshalb die Ziffern als
 *    Europe/Berlin und rechnet nach UTC. Wäre das falsch, käme die
 *    Vorankündigung zwei Stunden zu früh statt zu spät — der billigere
 *    Irrtum, und einer, der beim ersten Spiel auffällt.
 *
 * 3. **Namen von Jugendspielern sind maskiert** (`*`), in Aufstellung wie
 *    Torfolge. Verfolgen lässt sich die Mannschaft, nicht der Spieler.
 *
 * Kein Kontingent, kein Schlüssel — aber ein Vertrag, den niemand unterschrieben
 * hat: Ändert die Seite ihren Aufbau, bricht das hier. Deshalb ist eine leere
 * Antwort ein Fehlschlag (`HandballEmptyError`), nie eine leere Saison, und
 * der Job meldet über `sync_error`, statt das Cockpit still altern zu lassen.
 */

import { z, type ZodTypeAny } from 'zod';

export const HANDBALL_KIND = 'handball';

const BASE_URL = 'https://www.handball.net';
/** Eine gewöhnliche Browser-Kennung — ohne sie antwortet die API mit 403. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15_000;
/** Wie lange ein geholtes Token wiederverwendet wird. Der Ablauf liegt weit darüber. */
const TOKEN_TTL_MS = 10 * 60 * 1000;
/** Mehr Spiele hat keine Saison einer Mannschaft. */
const MATCHES_PER_PAGE = 100;

export class HandballTransientError extends Error {
  constructor(message: string) { super(message); this.name = 'HandballTransientError'; }
}
/** 401/403 auch nach frischem Token — die Seite hat den Zugang dichtgemacht. */
export class HandballBlockedError extends Error {
  constructor(message: string) { super(message); this.name = 'HandballBlockedError'; }
}
/** Die Antwort war formal in Ordnung und trotzdem leer oder unlesbar. */
export class HandballEmptyError extends Error {
  constructor(message: string) { super(message); this.name = 'HandballEmptyError'; }
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

let tokenCache: { token: string; fetchedAt: number } | null = null;

/** Nur für Tests. */
export function __resetHandballTokenForTests(): void {
  tokenCache = null;
}

function isTransientCause(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } })?.cause?.code
    ?? (err as { code?: string })?.code;
  return typeof code === 'string'
    && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code);
}

async function mitTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new HandballTransientError(`handball.net antwortet nicht (${FETCH_TIMEOUT_MS} ms)`);
    }
    if (isTransientCause(err)) {
      throw new HandballTransientError(`handball.net nicht erreichbar: ${(err as Error).message}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Das Token aus einer HTML-Antwort lesen — exportiert, weil es der einzige Parser der Seite ist. */
export function parseClientToken(html: string): string | null {
  const m = /<meta\s+name="client-token"\s+content="([^"]+)"/i.exec(html)
    ?? /<meta\s+content="([^"]+)"\s+name="client-token"/i.exec(html);
  return m?.[1]?.trim() || null;
}

async function fetchClientToken(force = false): Promise<string> {
  const now = Date.now();
  if (!force && tokenCache && now - tokenCache.fetchedAt < TOKEN_TTL_MS) return tokenCache.token;
  const res = await mitTimeout(`${BASE_URL}/`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
  });
  if (res.status >= 500) throw new HandballTransientError(`handball.net: HTTP ${res.status} beim Laden der Seite`);
  if (!res.ok) throw new HandballBlockedError(`handball.net: Seite nicht ladbar (HTTP ${res.status})`);
  const token = parseClientToken(await res.text());
  if (!token) {
    // Kein Token heißt nicht „kaputt", sondern „anders gebaut als am 26.09.2026".
    throw new HandballEmptyError('handball.net: kein client-token in der Seite — Aufbau der Seite geändert?');
  }
  tokenCache = { token, fetchedAt: now };
  return token;
}

/** Zähler seit dem Start — für `/healthz` und `/api/health`: Wie viele Abrufe, wie viele gescheitert, wann zuletzt einer gelang. */
const zaehler = { requests: 0, failures: 0, lastOkAt: null as string | null };

export function getHandballNetStats(): { requests: number; failures: number; last_ok_at: string | null } {
  return { requests: zaehler.requests, failures: zaehler.failures, last_ok_at: zaehler.lastOkAt };
}

/** Nur für Tests. */
export function __resetHandballNetStatsForTests(): void {
  zaehler.requests = 0; zaehler.failures = 0; zaehler.lastOkAt = null;
}

/** Abrufe, die gerade unterwegs sind — ein zweiter nach demselben Pfad hängt sich an den ersten. */
const unterwegs = new Map<string, Promise<unknown>>();

/**
 * Ein GET an die Quelle. Fragen zwei Aufrufer gleichzeitig denselben Pfad
 * (zwei Mannschaften derselben Staffel, Bot und Seite im selben Takt), geht
 * nur ein Abruf raus; beide bekommen dieselbe Antwort.
 */
function hnFetch<T>(path: string, schema?: ZodTypeAny, erneutBeiAbweisung = true): Promise<T> {
  const laufend = unterwegs.get(path);
  if (laufend) return laufend as Promise<T>;
  zaehler.requests++;
  const abruf = hnFetchEinzeln<T>(path, schema, erneutBeiAbweisung)
    .then(
      body => { zaehler.lastOkAt = new Date().toISOString(); return body; },
      err => { zaehler.failures++; throw err; },
    )
    .finally(() => { unterwegs.delete(path); });
  unterwegs.set(path, abruf);
  return abruf;
}

async function hnFetchEinzeln<T>(path: string, schema?: ZodTypeAny, erneutBeiAbweisung = true): Promise<T> {
  const token = await fetchClientToken();
  const res = await mitTimeout(`${BASE_URL}${path}`, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      Referer: `${BASE_URL}/`,
      Origin: BASE_URL,
      'x-client-token': token,
    },
  });
  if (res.status === 401 || res.status === 403) {
    if (erneutBeiAbweisung) {
      await fetchClientToken(true);
      return hnFetchEinzeln<T>(path, schema, false);
    }
    throw new HandballBlockedError(`handball.net: Zugang verweigert (HTTP ${res.status})`);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new HandballTransientError(`handball.net: HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`handball.net: HTTP ${res.status} für ${path}`);
  const body: unknown = await res.json();
  if (schema) {
    // Ändert die Quelle ihren Aufbau, soll das laut scheitern — mit dem Pfad
    // und der ersten abweichenden Stelle —, nicht als leere oder falsche Zahl enden.
    const geprueft = schema.safeParse(body);
    if (!geprueft.success) {
      const fund = geprueft.error.issues[0];
      throw new HandballEmptyError(`handball.net: Antwort auf ${path.split('?')[0]} hat nicht den erwarteten Aufbau (${fund?.path.join('.') || 'Wurzel'}: ${fund?.message ?? 'unbekannt'}) — Schnittstelle geändert?`);
    }
  }
  return body as T;
}

/**
 * Das Mindeste, worauf die Auswertung baut — bewusst locker (`passthrough`,
 * alles andere optional): geprüft wird, ob die Antwort noch die Gestalt hat,
 * nicht jedes Feld. Neue Felder der Quelle stören nicht.
 */
const SeasonsAntwort = z.object({ data: z.array(z.object({ id: z.number() }).passthrough()).optional() }).passthrough();
const MatchesAntwort = z.object({ data: z.array(z.object({ id: z.union([z.number(), z.string()]), date: z.string() }).passthrough()).optional() }).passthrough();
const StandingsAntwort = z.object({
  // `team` darf fehlen — `tabellenZeile` kommt ohne aus; `position` nicht.
  data: z.array(z.object({ position: z.number() }).passthrough()).optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Zeit und Namen
// ---------------------------------------------------------------------------

const BERLIN_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Berlin',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

/** Wandzeit in Europe/Berlin für einen Zeitpunkt, als UTC-Millisekunden derselben Ziffern. */
function berlinWallClockMs(instantMs: number): number {
  const p: Record<string, number> = {};
  for (const part of BERLIN_PARTS.formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/**
 * Eine Zeitangabe der Quelle nach UTC — die Ziffern als Europe/Berlin gelesen,
 * das Offset-Etikett der Quelle ignoriert (siehe Kopf, Punkt 2).
 *
 * Zwei Iterationen reichen für alle Zeitpunkte außerhalb der Umstellstunde;
 * innerhalb ist jede Antwort so gut wie die andere.
 */
export function sourceTimeToUtc(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (!m) throw new HandballEmptyError(`handball.net: unlesbare Zeitangabe „${raw}"`);
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  let guess = naive;
  for (let i = 0; i < 2; i++) {
    const offset = berlinWallClockMs(guess) - guess;
    guess = naive - offset;
  }
  return new Date(guess).toISOString();
}

/** Kurze Wörter, die trotz drei Buchstaben Wörter sind und keine Kürzel. */
const KLEINE_WOERTER = new Set(['bad', 'am', 'an', 'im', 'von', 'der', 'die', 'das', 'zu', 'ob', 'dem', 'den', 'und', 'bei', 'auf', 'alt', 'neu']);
const ROEMISCH = /^(i|ii|iii|iv|v|vi|vii|viii|ix|x)$/;

/**
 * „HSG WÖLFE VOREIFEL" → „HSG Wölfe Voreifel". Die Quelle schreibt manche
 * Namen durchgehend groß (Mannschaften, Hallen, Anschriften) und andere nicht
 * („TuS Niederpleis mB"). Angefasst wird nur, was keinen einzigen
 * Kleinbuchstaben a–z enthält; Umlaute zählen dabei nicht, weil die Quelle
 * „MüNSTERSTRASSE" schreibt. Kürzel bleiben groß: alles ohne Vokal (HSG,
 * BJSG, TV), alles bis drei Buchstaben, das kein Wort ist (TVE, HV), und
 * römische Zahlen (II, III).
 */
export function schoenerName(roh: string): string {
  const name = roh.trim();
  if (!name || /[a-zß]/.test(name)) return name;
  return name.toLowerCase().replace(/\p{L}+/gu, wort => {
    if (ROEMISCH.test(wort)) return wort.toUpperCase();
    if (!/[aeiouäöü]/.test(wort)) return wort.toUpperCase();
    if (wort.length <= 3 && !KLEINE_WOERTER.has(wort)) return wort.toUpperCase();
    return wort.charAt(0).toUpperCase() + wort.slice(1);
  });
}

// ---------------------------------------------------------------------------
// Formen
// ---------------------------------------------------------------------------

export interface HandballSeason {
  id: number;
  name: string;
  isActive: boolean;
}

export type HandballMatchStatus = 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled' | 'other';

export interface HandballMatch {
  /** Kennung der Quelle, z. B. „577132" — auch der Pfad `/match/577132` auf handball.net. */
  id: string;
  seasonId: number;
  /** Anwurf in UTC (ISO), aus der Ortszeit der Quelle gerechnet. */
  startsAt: string;
  status: HandballMatchStatus;
  /** Status, wie die Quelle ihn nennt („Finalizado", „Verschoben") — für die Anzeige des Sonderfalls. */
  statusName: string;
  round: number | null;
  phaseId: number | null;
  /** „Kreisoberliga mB" — der Name der Phase, sonst der Wettbewerb. */
  competitionName: string;
  /** „B-Jugend" — die Altersklasse, sofern die Quelle sie nennt. */
  championshipName: string | null;
  homeId: string;
  homeName: string;
  awayId: string;
  awayName: string;
  scoreHome: number | null;
  scoreAway: number | null;
  venueName: string | null;
  venueAddress: string | null;
  /** Koordinaten der Halle (`field.installation.latitude/longitude`), für den Routen-Knopf. */
  venueLat: number | null;
  venueLon: number | null;
  /** Der offizielle Spielberichtsbogen als PDF (`report`) — steht auch vor dem Spiel schon da. */
  reportUrl: string | null;
  /** Vereinslogos (`club.logo`, bei handball360.isquad.de) — nur zum einmaligen Holen, nie zum Ausliefern. */
  homeLogoUrl: string | null;
  awayLogoUrl: string | null;
}

export interface HandballStandingRow {
  /** Der Spieltag, nach dem diese Zeile gilt — die Quelle liefert eine Tabelle je Spieltag. */
  round: number;
  position: number;
  teamId: string;
  teamName: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalsDiff: number;
  points: number;
}

interface RawSeason { id: number; name: string; is_active: boolean }
interface RawTeam { id: number | string; name: string; club?: { logo?: string | null } | null }
interface RawStatus { id: number; name: string; is_live?: boolean; is_finished?: boolean }
interface RawMatch {
  id: number | string;
  round?: number | null;
  date: string;
  status?: RawStatus | null;
  phase?: {
    id?: number;
    name?: string;
    season_id?: number;
    competition?: { name?: string; championship?: { name?: string } | null } | null;
  } | null;
  local?: RawTeam | null;
  visitor?: RawTeam | null;
  result?: { local?: number | null; visitor?: number | null } | null;
  field?: {
    name?: string | null;
    installation?: { address?: string | null; latitude?: string | number | null; longitude?: string | number | null } | null;
  } | null;
  report?: string | null;
}
interface RawStanding {
  round?: number | null;
  position: number;
  team: RawTeam;
  played: number; won: number; drawn: number; lost: number;
  goals_for: number; goals_against: number; goals_diff: number; points: number;
}

function mapStatus(s: RawStatus | null | undefined): HandballMatchStatus {
  if (!s) return 'other';
  if (s.is_live) return 'live';
  if (s.is_finished) return 'finished';
  const name = s.name.toLowerCase();
  // Die Quelle mischt Deutsch und Spanisch: „Verschoben" und „Aplazado" sind
  // dasselbe, „Suspendido" ist abgesetzt, „Pendiente" ist angesetzt.
  if (/verschoben|aplazado|postpon/.test(name)) return 'postponed';
  if (/suspendido|abgesetzt|abgesagt|cancel|annull/.test(name)) return 'cancelled';
  if (/pendiente|angesetzt|scheduled|pending/.test(name)) return 'scheduled';
  return 'other';
}

function ganzzahl(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Koordinate der Quelle — als String („50.6464842") oder Zahl; 0 heißt „nicht gepflegt". */
function koordinate(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n !== 0 ? n : null;
}

export function mapMatch(raw: RawMatch): HandballMatch {
  return {
    id: String(raw.id),
    seasonId: raw.phase?.season_id ?? 0,
    startsAt: sourceTimeToUtc(raw.date),
    status: mapStatus(raw.status),
    statusName: raw.status?.name ?? '',
    round: ganzzahl(raw.round),
    phaseId: ganzzahl(raw.phase?.id),
    competitionName: raw.phase?.name || raw.phase?.competition?.name || 'Unbekannter Wettbewerb',
    championshipName: raw.phase?.competition?.championship?.name
      ? schoenerName(raw.phase.competition.championship.name)
      : null,
    homeId: String(raw.local?.id ?? ''),
    homeName: schoenerName(raw.local?.name ?? '?'),
    awayId: String(raw.visitor?.id ?? ''),
    awayName: schoenerName(raw.visitor?.name ?? '?'),
    scoreHome: ganzzahl(raw.result?.local),
    scoreAway: ganzzahl(raw.result?.visitor),
    venueName: raw.field?.name ? schoenerName(raw.field.name) : null,
    venueAddress: raw.field?.installation?.address ? schoenerName(raw.field.installation.address) : null,
    venueLat: koordinate(raw.field?.installation?.latitude),
    venueLon: koordinate(raw.field?.installation?.longitude),
    reportUrl: typeof raw.report === 'string' && /^https?:\/\//.test(raw.report) ? raw.report : null,
    homeLogoUrl: logoUrl(raw.local?.club?.logo),
    awayLogoUrl: logoUrl(raw.visitor?.club?.logo),
  };
}

/** Logo-Hosts der Quelle — alles andere wird gar nicht erst gespeichert. */
export const HANDBALL_LOGO_HOSTS = ['handball360.isquad.de', 'www.handball.net', 'handball.net'];

function logoUrl(v: unknown): string | null {
  if (typeof v !== 'string' || !/^https:\/\//.test(v)) return null;
  try {
    return HANDBALL_LOGO_HOSTS.includes(new URL(v).hostname) ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Abrufe
// ---------------------------------------------------------------------------

/** Die laufende Saison — die Quelle führt genau eine als aktiv. */
export async function fetchActiveSeason(): Promise<HandballSeason> {
  const body = await hnFetch<{ data?: RawSeason[] }>('/api/new/seasons', SeasonsAntwort);
  const aktive = (body.data ?? []).find(s => s.is_active) ?? (body.data ?? [])[0];
  if (!aktive) throw new HandballEmptyError('handball.net: keine Saison in der Antwort');
  return { id: aktive.id, name: aktive.name, isActive: !!aktive.is_active };
}

/**
 * Alle Spiele einer Mannschaft in einer Saison — 18 in einer Kreisoberliga.
 * Null Spiele heißt „falsche Team-ID oder Aufbau geändert", nie „spielfrei".
 */
export async function fetchTeamMatches(teamId: string, seasonId: number): Promise<HandballMatch[]> {
  const path = `/api/new/matches?team_id=${encodeURIComponent(teamId)}&season_id=${seasonId}&per_page=${MATCHES_PER_PAGE}`;
  const body = await hnFetch<{ data?: RawMatch[] }>(path, MatchesAntwort);
  const rows = body.data ?? [];
  if (rows.length === 0) {
    throw new HandballEmptyError(`handball.net: keine Spiele für Team ${teamId} in Saison ${seasonId} — Team-ID prüfen`);
  }
  return rows.map(mapMatch).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/**
 * Die Tabelle einer Staffel (Phase) — der Stand nach dem jüngsten Spieltag.
 *
 * Die Quelle liefert **eine Tabelle je Spieltag**, alle in einer Antwort:
 * 18 Spieltage × 10 Mannschaften = 180 Zeilen am 26.09.2026, jede mit
 * `round`. Die Zeilen der noch nicht gespielten Spieltage wiederholen den
 * aktuellen Stand. Ungefiltert stand die Tabelle im Tab 18-mal untereinander,
 * und der Bot baute daraus eine Nachricht jenseits der 4096 Zeichen, die
 * Telegram ohne Antwort ablehnte. Behalten wird der höchste `round`; als
 * Spieltag zählt aber die Zahl der gespielten Spiele — der höchste `round`
 * ist der letzte Spieltag der Saison, nicht der jüngste gespielte.
 */
export async function fetchStandings(phaseId: number, seasonId: number): Promise<HandballStandingRow[]> {
  return (await fetchStandingsWithHistory(phaseId, seasonId)).current;
}

export interface HandballStandingsFetch {
  /** Der Stand nach dem jüngsten Spieltag, `round` = Zahl der gespielten Spiele. */
  current: HandballStandingRow[];
  /**
   * Der Stand nach **jedem gespielten** Spieltag, `round` wie die Quelle ihn
   * nennt — die Historie, aus der der Tabellenplatz-Verlauf kommt. Ein
   * Spieltag zählt als gespielt, wenn wenigstens eine Mannschaft so viele
   * Spiele hat: Die Zeilen der Spieltage danach wiederholen nur den aktuellen
   * Stand (am 27.09.2026: Spieltag 1 bis 3 verschieden, 4 bis 18 gleich).
   */
  history: HandballStandingRow[];
}

function tabellenZeile(r: RawStanding, round: number): HandballStandingRow {
  return {
    round,
    position: r.position,
    teamId: String(r.team?.id ?? ''),
    teamName: schoenerName(r.team?.name ?? '?'),
    played: r.played ?? 0,
    won: r.won ?? 0,
    drawn: r.drawn ?? 0,
    lost: r.lost ?? 0,
    goalsFor: r.goals_for ?? 0,
    goalsAgainst: r.goals_against ?? 0,
    goalsDiff: r.goals_diff ?? 0,
    points: r.points ?? 0,
  };
}

/**
 * Wie `fetchStandings`, aber mit der Historie: Die Quelle liefert die Tabelle
 * je Spieltag ohnehin mit — bis zum 27.09.2026 wurde alles außer dem
 * jüngsten Stand weggeworfen. Jetzt bleiben die gespielten Spieltage als
 * Verlauf, ohne einen Aufruf mehr und ohne eigene Verlaufstabelle: Was die
 * Quelle bei jedem Abruf vollständig nennt, muss niemand selbst mitschreiben.
 */
export async function fetchStandingsWithHistory(phaseId: number, seasonId: number): Promise<HandballStandingsFetch> {
  const body = await hnFetch<{ data?: RawStanding[] }>(`/api/new/standings?phase_id=${phaseId}&season_id=${seasonId}`, StandingsAntwort);
  const alle = body.data ?? [];
  if (alle.length === 0) throw new HandballEmptyError(`handball.net: leere Tabelle für Staffel ${phaseId}`);
  const juengster = Math.max(...alle.map(r => r.round ?? 0));
  const rows = alle.filter(r => (r.round ?? 0) === juengster);
  // „Nach dem N. Spieltag": nicht die höchste Runde der Quelle (die ist der
  // letzte Spieltag der Saison, 18, und stand am 26.09.2026 so im Bild),
  // sondern die meisten gespielten Spiele einer Mannschaft.
  const spieltag = Math.max(0, ...rows.map(r => r.played ?? 0));
  const current = rows.map(r => tabellenZeile(r, spieltag)).sort((a, b) => a.position - b.position);

  const jeRunde = new Map<number, RawStanding[]>();
  for (const r of alle) {
    const runde = r.round ?? 0;
    if (runde <= 0) continue;
    const liste = jeRunde.get(runde) ?? [];
    liste.push(r);
    jeRunde.set(runde, liste);
  }
  const history: HandballStandingRow[] = [];
  for (const runde of [...jeRunde.keys()].sort((a, b) => a - b)) {
    const zeilen = jeRunde.get(runde)!;
    const meiste = Math.max(0, ...zeilen.map(r => r.played ?? 0));
    if (meiste < runde) continue;
    history.push(...zeilen.map(r => tabellenZeile(r, runde)).sort((a, b) => a.position - b.position));
  }
  return { current, history };
}

export interface HandballLineupPlayer {
  /** Kennung der Quelle — dieselbe wie im Kader (`fetchRoster`); der Name steht dort, hier nicht. */
  playerId: string;
  number: number;
  isGoalkeeper: boolean;
  isCaptain: boolean;
  goals: number;
  sevenMeterGoals: number;
  sevenMeterAttempts: number;
  twoMinutes: number;
}

export interface HandballLineupSide {
  teamId: string;
  teamName: string;
  players: HandballLineupPlayer[];
  staffCount: number;
}

export interface HandballLineup {
  home: HandballLineupSide;
  away: HandballLineupSide;
}

interface RawLineupEntry {
  player?: { id?: string | number | null } | null;
  number?: number | null;
  is_staff?: boolean;
  is_goalkeeper?: boolean;
  is_captain?: boolean;
  goals?: number | null;
  seven_meter_goals?: number | null;
  seven_meter_attempts?: number | null;
  two_minutes?: number | null;
}
interface RawLineupSide { team?: RawTeam | null; players?: RawLineupEntry[]; staff?: RawLineupEntry[] }

function mapLineupSide(raw: RawLineupSide | null | undefined): HandballLineupSide {
  const players = (raw?.players ?? [])
    .filter(p => !p.is_staff && typeof p.number === 'number')
    .map(p => ({
      playerId: String(p.player?.id ?? ''),
      number: p.number as number,
      isGoalkeeper: !!p.is_goalkeeper,
      isCaptain: !!p.is_captain,
      goals: p.goals ?? 0,
      sevenMeterGoals: p.seven_meter_goals ?? 0,
      sevenMeterAttempts: p.seven_meter_attempts ?? 0,
      twoMinutes: p.two_minutes ?? 0,
    }))
    .sort((a, b) => a.number - b.number);
  return {
    teamId: String(raw?.team?.id ?? ''),
    teamName: schoenerName(raw?.team?.name ?? '?'),
    players,
    staffCount: (raw?.staff ?? []).length,
  };
}

/**
 * Die Aufstellung eines Spiels — Rückennummern, Torwart, Kapitän, Tore je
 * Nummer. Namen liefert die Quelle bei Jugendspielen nicht (`*`), deshalb
 * stehen sie hier gar nicht erst im Modell. Vor dem Anwurf ist die Liste
 * leer; sie erscheint mit dem Ereignis „Spieler aufgestellt", rund zwei
 * Minuten vorher. Leer ist hier also **kein** Fehlschlag.
 */
export async function fetchLineups(matchId: string): Promise<HandballLineup> {
  const body = await hnFetch<{ data?: { local?: RawLineupSide; visitor?: RawLineupSide } }>(
    `/api/new/matches/${encodeURIComponent(matchId)}/lineups`,
  );
  return { home: mapLineupSide(body.data?.local), away: mapLineupSide(body.data?.visitor) };
}

// ---------------------------------------------------------------------------
// Torfolge und Spielbericht
// ---------------------------------------------------------------------------

export interface HandballMatchEvents {
  /** Der Stand am Ende der ersten Halbzeit — null, solange sie läuft. */
  halftime: { home: number; away: number } | null;
  /** Der jüngste Stand, den die Torfolge kennt. */
  latest: { home: number; away: number } | null;
  /** Minute („27:14") und Block („2. Halbzeit") des jüngsten Ereignisses — für `/live`. */
  latestMinute: string | null;
  latestBlock: string | null;
  /**
   * Spielminute des jüngsten Ereignisses über beide Halbzeiten
   * (`global_minute`, sonst aus `minute` „27:14" plus 25 je späterem Block).
   * Die Quelle liefert **keine** Uhrzeit je Ereignis — nur die Spieluhr. Der
   * Zeitzonen-Selbsttest rechnet damit zurück: Wer um 14:40 Uhr die 20.
   * Minute sieht, dessen Spiel hat spätestens um 14:20 Uhr begonnen.
   */
  latestGlobalMinute: number | null;
  /** Wie viele Ereignisse die Quelle führt — 0 vor dem Anwurf. */
  count: number;
}

interface RawEvent {
  minute?: string | null;
  global_minute?: number | null;
  block?: string | null;
  event_type?: { id?: number; name?: string; is_goal?: boolean } | null;
  score?: { local?: number | null; visitor?: number | null } | null;
}

/** Die Spielminute eines Ereignisses über beide Halbzeiten — null, wenn die Quelle keine nennt. */
function spielminute(e: RawEvent, blockName: string): number | null {
  if (typeof e.global_minute === 'number' && Number.isFinite(e.global_minute)) return e.global_minute;
  const m = /^(\d{1,3})(?::(\d{2}))?/.exec(e.minute ?? '');
  if (!m) return null;
  const minute = Number(m[1]) + Number(m[2] ?? 0) / 60;
  // Manche Quellen zählen die Uhr je Halbzeit neu; dann liegt die zweite 25 Minuten später.
  return /^2\./.test(blockName) && minute < 25 ? minute + 25 : minute;
}

/**
 * Halbzeitstand aus der Torfolge. Jedes Ereignis trägt `block` („ 1. Halbzeit",
 * mit führendem Leerzeichen) und den Stand danach (`score`). Die erste
 * Halbzeit gilt als vorbei, sobald ein Ereignis eines anderen Blocks da ist
 * oder eines im ersten Block „Ende" heißt (die Quelle nennt den Anpfiff
 * „Startseite Teil", das Gegenstück ist nicht belegt — deshalb beides).
 * Der Halbzeitstand ist dann der Stand des letzten Ereignisses im ersten Block.
 */
export function halbzeitAus(events: RawEvent[]): HandballMatchEvents {
  const block = (e: RawEvent) => (e.block ?? '').trim();
  const stand = (e: RawEvent | undefined) => (e?.score && typeof e.score.local === 'number' && typeof e.score.visitor === 'number')
    ? { home: e.score.local, away: e.score.visitor }
    : null;
  const erste = events.filter(e => /^1\./.test(block(e)));
  const andere = events.some(e => block(e) && !/^1\./.test(block(e)));
  const ende = erste.some(e => /ende|end\b|fin\b/i.test(e.event_type?.name ?? ''));
  const letztesErste = erste[erste.length - 1];
  const letztes = events[events.length - 1];
  return {
    halftime: (andere || ende) ? stand(letztesErste) : null,
    latest: stand(letztes),
    latestMinute: typeof letztes?.minute === 'string' && letztes.minute ? letztes.minute : null,
    latestBlock: letztes ? (block(letztes) || null) : null,
    latestGlobalMinute: letztes ? spielminute(letztes, block(letztes)) : null,
    count: events.length,
  };
}

/** Die Torfolge eines Spiels — leer vor dem Anwurf, deshalb ist leer kein Fehlschlag. */
export async function fetchMatchEvents(matchId: string): Promise<HandballMatchEvents> {
  const body = await hnFetch<{ data?: RawEvent[] }>(`/api/new/matches/${encodeURIComponent(matchId)}/events`);
  return halbzeitAus(body.data ?? []);
}

/**
 * Ein Ereignis der Torfolge, so knapp, wie die Microsite es braucht: die
 * Spielminute über beide Halbzeiten, der Stand danach, ob es ein Tor war.
 * Keine Namen — die maskiert die Quelle bei Jugendspielen ohnehin, und ein
 * Spielverlauf braucht sie nicht.
 */
export interface HandballMatchEventItem {
  /** Spielminute über beide Halbzeiten (60 = Abpfiff); null, wenn die Quelle keine nennt. */
  minute: number | null;
  home: number;
  away: number;
  goal: boolean;
  /** „1. Halbzeit" / „2. Halbzeit", wie die Quelle den Block nennt (getrimmt). */
  block: string;
}

/** Die rohe Torfolge in die Liste für den Spielverlauf bringen — nur Ereignisse mit Stand. */
export function torfolgeAus(events: RawEvent[]): HandballMatchEventItem[] {
  const out: HandballMatchEventItem[] = [];
  for (const e of events) {
    if (!e.score || typeof e.score.local !== 'number' || typeof e.score.visitor !== 'number') continue;
    const block = (e.block ?? '').trim();
    out.push({
      minute: spielminute(e, block),
      home: e.score.local,
      away: e.score.visitor,
      goal: e.event_type?.is_goal === true,
      block,
    });
  }
  return out;
}

/**
 * Dieselbe Torfolge als Liste — für den Spielverlauf auf der Microsite,
 * einmal nach dem Abpfiff vom Tageslauf geholt und am Spiel gespeichert.
 */
export async function fetchMatchEventList(matchId: string): Promise<HandballMatchEventItem[]> {
  const body = await hnFetch<{ data?: RawEvent[] }>(`/api/new/matches/${encodeURIComponent(matchId)}/events`);
  return torfolgeAus(body.data ?? []);
}

/**
 * Den Spielbericht der Quelle (`chronicle`, HTML mit h1/h2/p) in Telegram-
 * taugliche Absätze bringen: Zwischenüberschriften als „## …", Absätze durch
 * Leerzeilen getrennt, alle anderen Tags weg, Entities aufgelöst. Die h1
 * („Spielbericht: A vs. B") entfällt — der Bot setzt seine eigene Kopfzeile.
 */
export function chronicleToText(html: string): string {
  const entity = (t: string) => t
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  const bloecke: string[] = [];
  const re = /<(h1|h2|h3|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const inhalt = entity(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!inhalt) continue;
    if (tag === 'h1') continue;
    // Zwischenüberschriften als „## …" — gespeichert als Text, der Bot setzt sie fett.
    bloecke.push(tag === 'h2' || tag === 'h3' ? `## ${inhalt}` : inhalt);
  }
  if (bloecke.length === 0) {
    const nackt = entity(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    return nackt;
  }
  return bloecke.join('\n\n');
}

interface RawAdditionalInfo { chronicle?: string | null }

/**
 * Der Spielbericht — ein von der Quelle geschriebener Text in ganzen Sätzen
 * (`additional-info[].chronicle`). Er erscheint irgendwann nach dem Abpfiff;
 * wann genau, sagt die Seite nicht (am 26.09.2026 stand er zwei Stunden
 * danach). Fehlt er noch, kommt null — kein Fehlschlag.
 */
export async function fetchMatchReport(matchId: string): Promise<string | null> {
  const body = await hnFetch<{ data?: RawAdditionalInfo[] | RawAdditionalInfo | null }>(
    `/api/new/matches/${encodeURIComponent(matchId)}/additional-info`,
  );
  const eintraege = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
  const html = eintraege.map(e => (typeof e?.chronicle === 'string' ? e.chronicle.trim() : '')).find(Boolean);
  if (!html) return null;
  const text = chronicleToText(html);
  return text.length > 0 ? text : null;
}

export interface HandballRosterEntry {
  playerId: string;
  firstName: string;
  lastName: string;
  /** Rückennummer laut Kader — **nicht** verlässlich, siehe `fetchRoster`. */
  number: number | null;
  role: 'player' | 'staff';
}

interface RawRosterEntry {
  dorsal?: string | number | null;
  rol?: { id?: number; name?: string } | null;
  user?: { id?: string | number | null; first_name?: string | null; last_name?: string | null } | null;
}

/**
 * Der Kader einer Mannschaft — mit Namen, anders als Aufstellung und
 * Torfolge, die bei Jugendspielen maskieren. Die Brücke ist die Spieler-ID,
 * die in beiden Antworten steht.
 *
 * Über die **Rückennummer** darf nicht zugeordnet werden: Am 26.09.2026
 * stimmten bei 13 aufgestellten Wölfen 5 Kader-Nummern nicht mit den
 * getragenen überein (Nr. 22 stand im Kader bei Rosenfelder, im Spiel trug
 * sie Schüssler), zwei getragene Nummern fehlten im Kader ganz. Die ID traf
 * 13 von 13.
 */
export async function fetchRoster(teamId: string, seasonId: number): Promise<HandballRosterEntry[]> {
  const body = await hnFetch<{ data?: RawRosterEntry[] }>(
    `/api/new/teams/${encodeURIComponent(teamId)}/roster?season_id=${seasonId}`,
  );
  const rows = body.data ?? [];
  if (rows.length === 0) throw new HandballEmptyError(`handball.net: leerer Kader für Team ${teamId}`);
  return rows
    .filter(r => r.user?.id)
    .map(r => {
      const nummer = r.dorsal === null || r.dorsal === undefined || r.dorsal === '' ? null : Number(r.dorsal);
      return {
        playerId: String(r.user!.id),
        firstName: (r.user?.first_name ?? '').trim(),
        lastName: (r.user?.last_name ?? '').trim(),
        number: nummer !== null && Number.isFinite(nummer) ? nummer : null,
        role: r.rol?.id === 0 ? 'player' as const : 'staff' as const,
      };
    });
}

/** Klassifikation für Job und Dienste-Karte. */
export function klassifiziereHandballFehler(err: unknown): 'auth_error' | 'transient_error' {
  const name = err instanceof Error ? err.name : '';
  return name === 'HandballBlockedError' || name === 'HandballEmptyError' ? 'auth_error' : 'transient_error';
}
