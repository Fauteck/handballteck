/**
 * Die Sicht auf alle Mannschaften, wie Microsite, Bot, Kalender und `/api` sie
 * lesen: Spiele, Tabellen, Labels und Bereiche aus der Datenbank, zwischen-
 * gespeichert und eingefroren (PRF-1-002). Aus `handballTeam.ts` gelöst
 * (ARC-3-001) — dort bleiben Abruf, Speichern und die Auswertungen je
 * Mannschaft.
 */

import { inArray } from 'drizzle-orm';
import { db, sqlite } from '../db';
import { handball_team_match, handball_standings } from '../db/schema';
import { teamLabelAusConfig, konfigurationsStand, teamGroups } from '../config';
import type { HandballLiveState, HandballMatchEventItem, HandballStandingRow } from './handballNetClient';
import { ausTeamSicht, laeuftGerade, anzeigeName, torfolgeAusZeile, readTeamIds, NACHFASSEN_BIS_MS, gewerteteSpiele } from './handballTeam';

// ---------------------------------------------------------------------------
// Sicht für den Tab
// ---------------------------------------------------------------------------

/** Der Zwischenstand eines laufenden Spiels, wie ihn der Live-Takt gespeichert hat. */
export interface HandballLiveView extends HandballLiveState {
  /** Wann der Live-Takt ihn geholt hat (ISO, UTC). */
  fetched_at: string;
}

function liveAusZeile(payload: string | null): HandballLiveView | null {
  if (!payload) return null;
  try {
    const roh = JSON.parse(payload) as HandballLiveView;
    return roh && typeof roh === 'object' && typeof roh.fetched_at === 'string' && Array.isArray(roh.items) ? roh : null;
  } catch {
    return null;
  }
}

export interface HandballMatchView {
  match_id: string;
  season_id: number;
  starts_at: string;
  status: string;
  status_name: string;
  /** Läuft das Spiel gerade (`laeuftGerade`) — auch, wenn die Quelle es noch nicht meldet. */
  is_live: boolean;
  /** Der Zwischenstand des Live-Takts; null, solange keiner geholt wurde oder das Spiel nicht läuft. */
  live: HandballLiveView | null;
  round: number | null;
  competition_name: string;
  home_id: string;
  home_name: string;
  away_id: string;
  away_name: string;
  is_home: boolean;
  score_home: number | null;
  score_away: number | null;
  /** `true` gewonnen, `false` verloren, `null` offen oder unentschieden. */
  won: boolean | null;
  /**
   * Nicht auf beendet gesetzt, aber gewertet (Abbruch, Nichtantreten) —
   * `gewerteteSpiele`. Der Endstand geht dann mit „(gewertet)" raus.
   */
  rated: boolean;
  /** Halbzeitstand, sobald der Bot ihn aus der Torfolge gesehen hat. */
  halftime_home: number | null;
  halftime_away: number | null;
  venue_name: string | null;
  venue_address: string | null;
  venue_lat: number | null;
  venue_lon: number | null;
  /** Der offizielle Spielberichtsbogen (PDF) der Quelle. */
  report_url: string | null;
  /** Der Spielbericht der Quelle als Text, sobald geholt. */
  report_text: string | null;
  /** Die Torfolge, sobald der Tageslauf sie geholt hat (`[]` = keine); null = noch nie geholt. */
  events: HandballMatchEventItem[] | null;
  /** Die Seite des Spiels auf handball.net. */
  url: string;
}

export interface HandballStandingsView {
  phase_id: number;
  competition_name: string;
  fetched_at: string;
  rows: HandballStandingRow[];
  /** Der Stand davor — null, solange die Tabelle sich noch nie geändert hat. */
  previous_rows: HandballStandingRow[] | null;
  /** Der Stand nach jedem gespielten Spieltag (`round` der Quelle) — leer vor dem ersten Abruf mit Verlauf. */
  history_rows: HandballStandingRow[];
}

export type HandballGroup = 'herren' | 'frauen' | 'jungen' | 'maedchen' | 'kinder';

/** Die Reihenfolge und Namen der oberen Ebene der Mannschaftswahl. */
export const HANDBALL_GROUPS: ReadonlyArray<{ id: HandballGroup; label: string }> = [
  { id: 'herren', label: 'Herren' },
  { id: 'frauen', label: 'Damen' },
  { id: 'jungen', label: 'Jugend männlich' },
  { id: 'maedchen', label: 'Jugend weiblich' },
  { id: 'kinder', label: 'Kinder' },
];

export interface HandballTeamView {
  team_id: string;
  name: string;
  /**
   * Wie die Mannschaft neben den anderen des Vereins heißt — in der Mannschaftswahl der
   * Microsite und in der Auswahl des Bots: der Name aus `TEAM_IDS`, sonst
   * `automatischesLabel` („2. Herren", „mB-Jugend"), sonst die Altersklasse
   * der Quelle („B-Jugend"), sonst der Mannschaftsname.
   * Tragen zwei Mannschaften verschiedene Namen (zweite Mannschaft), steht
   * der Name davor.
   */
  label: string;
  championship_name: string | null;
  /** Die obere Ebene der Mannschaftswahl; null, wenn die Quelle weder Geschlecht noch Altersklasse verrät. */
  group: HandballGroup | null;
  next_match: HandballMatchView | null;
  last_match: HandballMatchView | null;
  matches: HandballMatchView[];
  standings: HandballStandingsView[];
}

export interface HandballOverview {
  configured: boolean;
  teams: HandballTeamView[];
  /** Jüngster Schreibzeitpunkt irgendeiner Zeile — „Stand: vor 3 Std." im Tab. */
  updated_at: string | null;
}

/**
 * Eine gespeicherte Tabelle auf den jüngsten Spieltag bringen.
 *
 * Seit dem 26.09.2026 filtert `fetchStandings` selbst (`round`), aber die bis
 * dahin gespeicherten Schnappschüsse tragen alle 180 Zeilen und kein `round`
 * — und der Tageslauf holt erst morgen neu. Für die alte Form bleibt je
 * Mannschaft die Zeile mit den meisten Spielen: Die noch ungespielten
 * Spieltage wiederholen den aktuellen Stand, also ist das der jüngste.
 */
export function normalisiereTabelle(rows: HandballStandingRow[]): HandballStandingRow[] {
  if (rows.length === 0) return rows;
  const mitRunde = rows.filter(r => typeof r.round === 'number' && Number.isFinite(r.round));
  let ergebnis: HandballStandingRow[];
  if (mitRunde.length === rows.length) {
    const juengster = Math.max(...rows.map(r => r.round));
    ergebnis = rows.filter(r => r.round === juengster);
  } else {
    const beste = new Map<string, HandballStandingRow>();
    for (const r of rows) {
      const bisher = beste.get(r.teamId);
      if (!bisher || r.played > bisher.played) beste.set(r.teamId, r);
    }
    ergebnis = [...beste.values()];
  }
  // Der Spieltag ist die Zahl der gespielten Spiele — Schnappschüsse vor dem
  // 27.09.2026 trugen hier den letzten Spieltag der Saison (18).
  const spieltag = Math.max(0, ...ergebnis.map(r => r.played));
  return ergebnis.map(r => ({ ...r, round: spieltag })).sort((a, b) => a.position - b.position);
}

function sicht(r: typeof handball_team_match.$inferSelect, rated = false): HandballMatchView {
  const s = ausTeamSicht(r);
  const won = (r.status === 'finished' || rated) && s.eigeneTore !== null && s.gegnerTore !== null && s.eigeneTore !== s.gegnerTore
    ? s.eigeneTore > s.gegnerTore
    : null;
  return {
    match_id: r.match_id,
    season_id: r.season_id,
    starts_at: r.starts_at,
    status: r.status,
    status_name: r.status_name,
    is_live: laeuftGerade(r.status, r.starts_at),
    live: laeuftGerade(r.status, r.starts_at) ? liveAusZeile(r.live_payload) : null,
    round: r.round,
    competition_name: r.competition_name,
    home_id: r.home_id,
    home_name: anzeigeName(r.home_id, r.home_name),
    away_id: r.away_id,
    away_name: anzeigeName(r.away_id, r.away_name),
    is_home: s.heim,
    score_home: r.score_home,
    score_away: r.score_away,
    won,
    rated,
    halftime_home: r.halftime_home,
    halftime_away: r.halftime_away,
    venue_name: r.venue_name,
    venue_address: r.venue_address,
    venue_lat: r.venue_lat,
    venue_lon: r.venue_lon,
    report_url: r.report_url,
    report_text: r.report_text,
    events: torfolgeAusZeile(r.events_payload),
    url: `https://www.handball.net/match/${encodeURIComponent(r.match_id)}?season_id=${r.season_id}`,
  };
}

const ROEMISCH: Record<string, number> = { II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

/**
 * Der Name in der Mannschaftswahl, aus den Daten der Quelle gelesen — so, wie der Verein
 * seine Mannschaften nennt: „1. Herren", „3. Damen", „mB-Jugend", „wC-Jugend".
 *
 * Maßgeblich ist der Wettbewerb mit den meisten Spielen, nicht das erste
 * Spiel: Vor der Saison steht oft ein Testspiel vorn („Testspiele Senioren
 * m/w"), und das sagt weder Geschlecht noch Liga. Die Nummer einer
 * Erwachsenenmannschaft kommt aus dem Namen („Wölfe Voreifel III"), ohne
 * Zusatz ist es die erste. null, wenn die Quelle nichts Eindeutiges sagt —
 * dann bleibt es bei Altersklasse oder Vereinsname.
 */
export function automatischesLabel(name: string, rows: Array<{ competition_name: string; championship_name: string | null }>): string | null {
  const zaehler = new Map<string, number>();
  for (const r of rows) zaehler.set(r.competition_name, (zaehler.get(r.competition_name) ?? 0) + 1);
  const wettbewerb = [...zaehler.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!wettbewerb) return null;
  const altersklasse = rows.find(r => r.competition_name === wettbewerb)?.championship_name ?? null;

  const jugend = /\b(männlich|weiblich)e?\s+Jugend\s+([A-E])\b/i.exec(wettbewerb)
    ?? /\b([mw])J?([A-E])\b/.exec(wettbewerb);
  if (jugend) return `${jugend[1][0].toLowerCase()}${jugend[2].toUpperCase()}-Jugend`;
  const klasse = /\b([A-E])-?Jugend\b/i.exec(`${wettbewerb} ${altersklasse ?? ''}`);
  if (klasse) return `${klasse[1].toUpperCase()}-Jugend`;

  const geschlecht = /\b(Männer|Herren)\b/i.test(wettbewerb) ? 'Herren' : /\b(Frauen|Damen)\b/i.test(wettbewerb) ? 'Damen' : null;
  if (!geschlecht) return null;
  const zusatz = /\s(II|III|IV|V|VI|VII|VIII|IX|X|\d{1,2})$/.exec(name.trim())?.[1];
  const nummer = zusatz ? (ROEMISCH[zusatz] ?? Number(zusatz)) : 1;
  return `${nummer}. ${geschlecht}`;
}

/**
 * Kinder sind E- und F-Jugend, Minis und ausdrücklich so benannte Mannschaften
 * (auch gemischte) — sie bilden eine eigene Gruppe neben der männlichen und
 * der weiblichen Jugend (A–D).
 */
const KINDER: readonly RegExp[] = [
  /\b[mwg]?J?-?[EF]-?Jugend\b/i,
  /\b[mwg]J-?[EF]\b/,
  /\b[mwg][EF]\b/,
  /\bMinis?\b/i,
  /\bKinder\b/i,
];

/**
 * Zu welcher Gruppe der Mannschaftswahl die Mannschaft gehört: Herren, Damen,
 * männliche Jugend (mA–mD), weibliche Jugend (wA–wD) oder Kinder (E, F, Minis). Maßgeblich ist wie beim Label der
 * Wettbewerb mit den meisten Spielen; fehlt dort das Geschlecht, helfen der
 * Mannschaftsname und zuletzt das Label (auch ein Name aus `TEAM_IDS`:
 * „mB-Jugend", „2. Damen"). null, wenn nichts davon eindeutig ist.
 */
export function gruppeVon(name: string, rows: Array<{ competition_name: string; championship_name: string | null }>, label: string | null): HandballGroup | null {
  const zaehler = new Map<string, number>();
  for (const r of rows) zaehler.set(r.competition_name, (zaehler.get(r.competition_name) ?? 0) + 1);
  const wettbewerb = [...zaehler.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const quellen = [wettbewerb, name, label ?? ''];
  for (const text of quellen) {
    if (KINDER.some(re => re.test(text))) return 'kinder';
    if (/\bmännlich(e|en)?\b/i.test(text) || /\bm(J|-?Jugend)?-?[A-E]\b/.test(text) || /\bJungen\b/i.test(text)) return 'jungen';
    if (/\bweiblich(e|en)?\b/i.test(text) || /\bw(J|-?Jugend)?-?[A-E]\b/.test(text) || /\bMädchen\b/i.test(text)) return 'maedchen';
    if (/\b(Männer|Herren)\b/i.test(text)) return 'herren';
    if (/\b(Frauen|Damen)\b/i.test(text)) return 'frauen';
  }
  return null;
}

/**
 * Der Bereich, den die Seite je Mannschaft aus Wettbewerb und Name liest —
 * ohne die Hand-Einstellung `TEAM_GROUPS`. Für die Einstellungsseite: Sie
 * zeigt ihn als „automatisch“ und gruppiert die Zeilen danach. Null, wenn
 * sich nichts lesen lässt (noch keine Spiele, kein Hinweis im Namen).
 */
export function automatischeBereiche(): Record<string, HandballGroup | null> {
  const teams = readTeamIds();
  const alle = teams.length > 0 ? db.select().from(handball_team_match).where(inArray(handball_team_match.team_id, teams)).all() : [];
  const out: Record<string, HandballGroup | null> = {};
  for (const teamId of teams) {
    const meine = laufendeSaison(alle.filter(r => r.team_id === teamId));
    const erste = meine[0];
    const quellname = erste ? (erste.home_id === teamId ? erste.home_name : erste.away_name) : `Team ${teamId}`;
    const label = teamLabelAusConfig(teamId) ?? automatischesLabel(quellname, meine) ?? erste?.championship_name ?? quellname;
    out[teamId] = gruppeVon(quellname, meine, label);
  }
  return out;
}

/**
 * Für die Microsite: In Spielen heißen die eigenen Mannschaften wie überall auf
 * der Seite — unter ihrem Label („D1 (RTV)"), nicht unter dem Vereinsnamen mit
 * der Ziffer der Quelle („Wölfe Voreifel II"); auch als Gegner einer anderen
 * eigenen. Bot, Kalender des Bots und `/api` behalten den Vereinsnamen, denn
 * dort fehlt der Zusammenhang der Seite. Liefert eine Kopie; die übergebene
 * Sicht bleibt, wie sie ist (sie kann die eingefrorene aus dem Zwischenspeicher sein).
 */
export function mitLabelsInSpielen(vorlage: HandballOverview): HandballOverview {
  const sicht = structuredClone(vorlage);
  const labelVon = new Map(sicht.teams.map(v => [v.team_id, v.label]));
  const benennen = (m: HandballMatchView | null) => {
    if (!m) return;
    m.home_name = labelVon.get(m.home_id) ?? m.home_name;
    m.away_name = labelVon.get(m.away_id) ?? m.away_name;
  };
  for (const v of sicht.teams) {
    v.matches.forEach(benennen);
    benennen(v.next_match);
    benennen(v.last_match);
  }
  return sicht;
}

/**
 * Der Tab liest ausschließlich die Datenbank — **kein** Aufruf nach draußen.
 * Gefüllt hat sie der Job; steht dort nichts, sagt der Tab das.
 */
/**
 * Die Spiele einer Mannschaft in ihrer laufenden Saison, aufsteigend nach
 * Anwurf. PRF-3-003: Spiele vergangener Saisons bleiben in der Datenbank,
 * die Übersicht trug sie aber mit — sie wuchs mit jeder Saison, und alte
 * Tabellen, Labels und Bilanzen mischten sich in die neue. Laufend ist die
 * Saison des jüngsten Spiels.
 */
function laufendeSaison<T extends { starts_at: string; season_id: number }>(spiele: T[]): T[] {
  const sortiert = spiele.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const saison = sortiert.at(-1)?.season_id;
  return sortiert.filter(r => r.season_id === saison);
}

/**
 * Die Saison einer Mannschaft, wie sie gerade läuft: die des jüngsten Spiels.
 * `matches` ist aufsteigend nach Anwurf sortiert — `[0]` wäre nach einem
 * Saisonwechsel die alte Saison (ARC-2-002).
 */
export function aktuellesSpiel<T extends { season_id: number }>(matches: readonly T[]): T | undefined {
  return matches.at(-1);
}

// PRF-1-002: Die Übersicht liest alle Spiele und Tabellen aller Mannschaften
// samt ihrem JSON — rund 10 ms je Aufbau, und jede Route der Microsite, des
// Bots und der API fragte sie neu. Sie gilt, bis die Datenbank geschrieben
// wird (`total_changes()` der einen Verbindung zählt jede geänderte Zeile),
// sich ein gelesener Wert der Konfiguration ändert oder SICHT_FRIST_MS
// vergehen — „nächstes Spiel" und Wertung hängen an der Uhr. Alle Aufrufer
// bekommen dasselbe Objekt, deshalb ist es eingefroren.
const SICHT_FRIST_MS = 10_000;
type SichtEintrag = { schluessel: string; at: number; sicht: HandballOverview };
const sichtCache: { roh: SichtEintrag | null; seite: SichtEintrag | null } = { roh: null, seite: null };
const geaenderteZeilen = sqlite.prepare('SELECT total_changes()').pluck();

function einfrieren<T>(wert: T): T {
  if (wert && typeof wert === 'object' && !Object.isFrozen(wert)) {
    Object.freeze(wert);
    for (const kind of Object.values(wert)) einfrieren(kind);
  }
  return wert;
}

function zwischengespeichert(art: 'roh' | 'seite', bauen: () => HandballOverview): HandballOverview {
  const schluessel = `${geaenderteZeilen.get() as number}\u0000${konfigurationsStand()}`;
  const jetzt = Date.now();
  const e = sichtCache[art];
  if (e && e.schluessel === schluessel && jetzt >= e.at && jetzt - e.at < SICHT_FRIST_MS) return e.sicht;
  const sicht = einfrieren(bauen());
  sichtCache[art] = { schluessel, at: jetzt, sicht };
  return sicht;
}

/** Die Übersicht aller Mannschaften — zwischengespeichert und eingefroren. */
export function handballOverview(): HandballOverview {
  return zwischengespeichert('roh', baueUebersicht);
}

/** Dieselbe Übersicht für die Microsite: Spiele tragen die Labels der eigenen Mannschaften. */
export function seitenUebersicht(): HandballOverview {
  return zwischengespeichert('seite', () => mitLabelsInSpielen(handballOverview()));
}

function baueUebersicht(): HandballOverview {
  const teams = readTeamIds();
  if (teams.length === 0) return { configured: false, teams: [], updated_at: null };

  const alle = teams.length > 0
    ? db.select().from(handball_team_match).where(inArray(handball_team_match.team_id, teams)).all()
    : [];
  const tabellen = db.select().from(handball_standings).all();
  const jetzt = Date.now();
  let updatedAt: string | null = null;

  const views = teams.map(teamId => {
    const meine = laufendeSaison(alle.filter(r => r.team_id === teamId));
    for (const r of meine) if (!updatedAt || r.updated_at > updatedAt) updatedAt = r.updated_at;
    const erste = meine[0];
    // Das Label und die Gruppe lesen den Namen der Quelle („… III"), angezeigt wird `anzeigeName`.
    const quellname = erste ? (erste.home_id === teamId ? erste.home_name : erste.away_name) : `Team ${teamId}`;
    const name = anzeigeName(teamId, quellname);
    // „Nächstes" schließt ein laufendes Spiel ein — und lässt Verlegtes ohne
    // neuen Termin außen vor, dessen altes Datum sonst als nächstes stünde.
    const naechstes = meine.find(r => (r.status === 'scheduled' || r.status === 'live')
      && (r.status === 'live' || Date.parse(r.starts_at) + NACHFASSEN_BIS_MS > jetzt));
    const phasen = [...new Set(meine.map(r => r.phase_id).filter((p): p is number => p !== null))];
    const standings = tabellen
      .filter(t => phasen.includes(t.phase_id))
      .map(t => {
        let rows: HandballStandingRow[] = [];
        try { rows = normalisiereTabelle(JSON.parse(t.payload) as HandballStandingRow[]); } catch { rows = []; }
        let previous: HandballStandingRow[] | null = null;
        if (t.previous_payload) {
          try { previous = normalisiereTabelle(JSON.parse(t.previous_payload) as HandballStandingRow[]); } catch { previous = null; }
        }
        let history: HandballStandingRow[] = [];
        if (t.history_payload) {
          try { history = JSON.parse(t.history_payload) as HandballStandingRow[]; } catch { history = []; }
        }
        const benannt = (zeilen: HandballStandingRow[]) => zeilen.map(z => ({ ...z, teamName: anzeigeName(z.teamId, z.teamName) }));
        return { phase_id: t.phase_id, competition_name: t.competition_name, fetched_at: t.fetched_at, rows: benannt(rows), previous_rows: previous ? benannt(previous) : null, history_rows: benannt(history) };
      });
    const gewertet = gewerteteSpiele(teamId, meine, standings, jetzt);
    const zuletzt = meine.filter(r => r.status === 'finished' || gewertet.has(r.match_id));
    const label = teamLabelAusConfig(teamId) ?? automatischesLabel(quellname, meine) ?? erste?.championship_name ?? name;
    return {
      team_id: teamId,
      name,
      label,
      championship_name: erste?.championship_name ?? null,
      // Ein von Hand gesetzter Bereich (TEAM_GROUPS) geht dem gelesenen vor.
      group: teamGroups().get(teamId) ?? gruppeVon(quellname, meine, label),
      next_match: naechstes ? sicht(naechstes) : null,
      last_match: zuletzt.length > 0 ? sicht(zuletzt[zuletzt.length - 1], gewertet.has(zuletzt[zuletzt.length - 1].match_id)) : null,
      matches: meine.map(r => sicht(r, gewertet.has(r.match_id))),
      standings,
    };
  });

  // Mehrere Mannschaften desselben Vereins heißen bei der Quelle gleich
  // („HSG Wölfe Voreifel") und unterscheiden sich nur in der Altersklasse:
  // Der Name bekommt dann das Label dazu, damit `/spiele` und die Kopfzeile
  // der Seite sie auseinanderhalten. Heißen sie verschieden („… II"), trägt
  // das Label den Namen, denn „B-Jugend" allein sagte nicht, welche — es sei
  // denn, das automatische Label unterscheidet sie schon („2. Herren").
  // Zwei gleiche automatische Labels (zwei mB-Jugenden) unterscheiden nichts —
  // dann zurück zur Altersklasse der Quelle bzw. zum Namen.
  const doppelt = new Map<string, number>();
  for (const v of views) doppelt.set(v.label, (doppelt.get(v.label) ?? 0) + 1);
  for (const v of views) {
    if ((doppelt.get(v.label) ?? 0) > 1 && !teamLabelAusConfig(v.team_id)) v.label = v.championship_name ?? v.name;
  }
  const gleich = new Map<string, number>();
  for (const v of views) gleich.set(v.name, (gleich.get(v.name) ?? 0) + 1);
  const labels = new Map<string, number>();
  for (const v of views) labels.set(v.label, (labels.get(v.label) ?? 0) + 1);
  if (gleich.size > 1) {
    for (const v of views) {
      if (teamLabelAusConfig(v.team_id)) continue;
      if (v.label !== v.championship_name && v.label !== v.name && labels.get(v.label) === 1) continue;
      v.label = v.championship_name ? `${v.name} · ${v.championship_name}` : v.name;
    }
  }
  for (const v of views) if ((gleich.get(v.name) ?? 0) > 1 && v.label !== v.name) v.name = `${v.name} ${v.label}`;
  return { configured: true, teams: views, updated_at: updatedAt };
}
