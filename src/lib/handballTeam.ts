/**
 * Handball-Verfolgung: Spielplan, Tabelle, Kader, Logos und Torfolgen je
 * eingetragener Mannschaft — der Abruf bei handball.net (README §Abruf).
 *
 * Gebaut nach dem Muster der Darts-Favoriten (lib/dartsFavourites.ts), nur
 * ohne deren Kontingent-Sorge: handball.net kennt kein Kontingent, dafür
 * keinen Vertrag. Der Zuschnitt bleibt trotzdem sparsam, weil ein Aufruf,
 * der nichts bringt, auch bei einer freien Quelle ein Aufruf ist, den jemand
 * irgendwann sperrt:
 *
 * - **Einmal je Kalendertag** kommen je Mannschaft der ganze Saison-Spielplan
 *   (ein Aufruf) und die Tabelle jeder Staffel, in der sie spielt (meist
 *   eine). Verlegte Spiele ziehen dabei mit, weil Datum und Status je Lauf
 *   neu kommen und die Zeile am Spiel hängt, nicht am Termin.
 * - **Jeder weitere Tick kostet nichts**, solange kein gespeichertes Spiel
 *   läuft. Die Vorankündigung braucht keinen Abruf: Der Anwurf steht seit
 *   dem Tageslauf in der Tabelle.
 * - **Am Spieltag** wird ab Anwurf plus 45 Minuten nachgefasst, bis der
 *   Status auf beendet steht — ein Jugendspiel dauert 2 × 25 Minuten plus
 *   Pause. Danach noch einmal die Tabelle, damit der Tab nach dem Endstand
 *   nicht die Tabelle von gestern zeigt.
 *
 * Die Meldungen an Menschen gehen von hier aus über den Telegram-Bot
 * (lib/handballBot.ts) und die Microsite (lib/handballSitePush.ts); Todoteck
 * liest dieselbe Sicht über `GET /api/overview` und meldet seinen Nutzern
 * selbst. Die Spalten `notified_upcoming`/`notified_result` sind geblieben,
 * damit ein Import aus Todoteck eins zu eins geht — gesetzt werden sie hier
 * nicht mehr.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { handball_team_match, handball_standings, handball_roster, handball_match_player, handball_match_change, handball_team_logo, handball_opponent_form } from '../db/schema';
import { safeFetchImage } from './safeFetch';
import { teamIds as configTeamIds, palette as configPalette, teamLabelAusConfig } from '../config';
import {
  HANDBALL_KIND,
  fetchActiveSeason,
  fetchTeamMatches,
  fetchStandingsWithHistory,
  fetchRoster,
  fetchLineups,
  fetchMatchReport,
  fetchMatchEventList,
  HANDBALL_LOGO_HOSTS,
  klassifiziereHandballFehler,
  HandballEmptyError,
  type HandballMatch,
  type HandballStandingRow,
  type HandballLineupSide,
  type HandballMatchEvents,
  type HandballMatchEventItem,
} from './handballNetClient';
import type { HandballPalette } from './handballTableImage';
import { meldeBetreiber, entwarnung } from './alerts';
import { KeyedBackoff, DEFAULT_LOG_THRESHOLD, AUTH_BACKOFF_MS, TRANSIENT_BACKOFF_MS } from './pollerBackoff';
import { serviceLog } from './serviceLogger';

export const HANDBALL_LABEL = 'Handball (handball.net)';

/** Ab wann nach dem Anwurf nachgefasst wird: 2 × 25 Minuten plus Pause, minus etwas Luft. */
const NACHFASSEN_AB_MS = 45 * 60 * 1000;
/** Bis wann: Ein Spiel, das sechs Stunden nach Anwurf nicht beendet ist, holt der nächste Tageslauf. */
const NACHFASSEN_BIS_MS = 6 * 60 * 60 * 1000;
/** Wie viele beendete Spiele ohne gespeicherte Aufstellung ein Tageslauf nachholt — Altbestand in Häppchen. */
const AUFSTELLUNGEN_JE_LAUF = 5;
/** Eine Änderung an einem Spiel, das länger her ist, ist Buchhaltung der Quelle, keine Nachricht. */
const AENDERUNG_MAX_ALTER_MS = 24 * 60 * 60 * 1000;
/** Das Vereinslogo wird nach dieser Frist erneut geholt — ein Verein wechselt sein Logo selten. */
const LOGO_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Logos je Tageslauf — der erste Lauf holt die eigene Mannschaft und die Gegner in Häppchen. */
const LOGOS_JE_LAUF = 10;
/** Torfolgen beendeter Spiele je Takt — ein Aufruf je Spiel, einmalig (auch eine leere Antwort wird gespeichert). */
const TORFOLGEN_JE_LAUF = 3;
/** Spielberichte je Tageslauf und Mannschaft — für Spiele, deren Endstand der Bot nie meldete (kein Bot, Ausfall). */
const BERICHTE_JE_TAGESLAUF = 3;
/** Ein Bericht wird nur so lange nachgefragt — was nach 30 Tagen nicht da ist, kommt nicht mehr. */
const BERICHT_NACHFRAGEN_BIS_MS = 30 * 24 * 60 * 60 * 1000;

/** Für die Dienste-Karte: Fehler-Serie und Backoff unter `getBackoffSnapshot('handball', 'team')`. */
const backoff = new KeyedBackoff(DEFAULT_LOG_THRESHOLD, 'handball');
const BACKOFF_KEY = 'team';
let lastError: string | null = null;

export function getHandballHealth(): { lastError: string | null } {
  return { lastError };
}

function berlinDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** Die Team-IDs aus der Konfiguration (`TEAM_IDS`) — siehe `config.ts`. */
export { parseTeamIds } from '../config';

export function readTeamIds(): string[] {
  return configTeamIds();
}

/**
 * Die Vereinsfarben aus der Konfiguration (`PRIMARY_COLOR`, `SECONDARY_COLOR`,
 * `ACCENT_COLOR`, je `#rrggbb`). Was fehlt oder nicht passt, bleibt leer —
 * `themeFor` setzt dann die Wölfe-Farben ein.
 */
export function readPalette(): Partial<HandballPalette> {
  return configPalette();
}

function upsertMatch(teamId: string, m: HandballMatch): void {
  const now = new Date().toISOString();
  const id = `${teamId}:${m.id}`;
  const existing = db.select().from(handball_team_match).where(eq(handball_team_match.id, id)).get();
  const felder = {
    team_id: teamId,
    match_id: m.id,
    season_id: m.seasonId,
    starts_at: m.startsAt,
    status: m.status,
    status_name: m.statusName,
    round: m.round,
    phase_id: m.phaseId,
    competition_name: m.competitionName,
    championship_name: m.championshipName,
    home_id: m.homeId,
    home_name: m.homeName,
    away_id: m.awayId,
    away_name: m.awayName,
    score_home: m.scoreHome,
    score_away: m.scoreAway,
    venue_name: m.venueName,
    venue_address: m.venueAddress,
    venue_lat: m.venueLat,
    venue_lon: m.venueLon,
    report_url: m.reportUrl,
    home_logo_url: m.homeLogoUrl,
    away_logo_url: m.awayLogoUrl,
    updated_at: now,
  };
  if (!existing) {
    db.insert(handball_team_match).values({
      id, ...felder, notified_upcoming: false, notified_result: false,
      // Ein Spiel, das beim ersten Sehen schon beendet ist, hat keinen
      // beobachteten Statuswechsel — der Zeitzonen-Selbsttest lässt es aus.
      unfinished_seen_at: m.status === 'finished' ? null : now,
    }).run();
    return;
  }
  // Die Merker bleiben, was sie sind — sie gehören der Meldung, nicht dem
  // Abruf. Ein verlegtes Spiel bekommt seine Vorankündigung aber erneut:
  // Der alte Merker gehörte zu einem Termin, der nicht mehr gilt.
  const verlegt = existing.starts_at !== m.startsAt && m.status !== 'finished';
  // Zeitzonen-Selbsttest (§6): wann zuletzt unbeendet, wann zuerst beendet gesehen.
  const jetztBeendet = m.status === 'finished' && existing.status !== 'finished';
  const beobachtet = m.status === 'finished'
    ? (jetztBeendet ? { finished_seen_at: now } : {})
    : { unfinished_seen_at: now };
  db.update(handball_team_match)
    .set({ ...(verlegt ? { ...felder, notified_upcoming: false } : felder), ...beobachtet })
    .where(eq(handball_team_match.id, id))
    .run();
  if (jetztBeendet && !existing.tz_check) bewerteZeitzone(teamId, id);
  const aenderung = erkenneAenderung(existing, m, Date.parse(now));
  if (aenderung) {
    db.insert(handball_match_change).values({
      team_id: teamId, match_id: m.id, kind: aenderung,
      old_starts_at: existing.starts_at, new_starts_at: m.startsAt, detected_at: now,
    }).run();
  }
}

export type HandballChangeKind = 'rescheduled' | 'postponed' | 'cancelled';

/**
 * Was sich an einem gespeicherten Spiel geändert hat, das eine Nachricht wert
 * ist. Bis zum 26.09.2026 kam der Status „Verschoben" nur stumm in der
 * Datenbank an — für jemanden, der mit in die Halle wollte, die nützlichste
 * Meldung der Saison. Ein beendetes Spiel ändert sich nicht mehr; eine
 * Änderung an einem Spiel, das länger als einen Tag her ist, ist Nachpflege
 * der Quelle und keine Nachricht.
 */
export function erkenneAenderung(
  alt: { status: string; starts_at: string },
  neu: { status: string; startsAt: string; scoreHome?: number | null; scoreAway?: number | null },
  jetzt: number,
): HandballChangeKind | null {
  if (alt.status === 'finished' || neu.status === 'finished') return null;
  // Abgesetzt, aber mit Ergebnis: eine Wertung (Nichtantreten, Abbruch) —
  // die meldet der Endstand mit „(gewertet)", nicht die Absage.
  if (neu.status === 'cancelled' && neu.scoreHome != null && neu.scoreAway != null) return null;
  if (Date.parse(alt.starts_at) < jetzt - AENDERUNG_MAX_ALTER_MS && Date.parse(neu.startsAt) < jetzt - AENDERUNG_MAX_ALTER_MS) return null;
  if (neu.status === 'cancelled') return alt.status === 'cancelled' ? null : 'cancelled';
  if (alt.starts_at !== neu.startsAt) return 'rescheduled';
  if (neu.status === 'postponed') return alt.status === 'postponed' ? null : 'postponed';
  return null;
}

export interface HandballChangeView {
  change_id: number;
  kind: HandballChangeKind;
  old_starts_at: string;
  new_starts_at: string;
  detected_at: string;
}

/** Alle erkannten Änderungen einer Mannschaft, älteste zuerst — der Bot filtert über seine Merker. */
export function changesFor(teamId: string): Array<HandballChangeView & { match_id: string }> {
  return db.select().from(handball_match_change).where(eq(handball_match_change.team_id, teamId)).all()
    .sort((a, b) => a.id - b.id)
    .map(c => ({
      change_id: c.id, match_id: c.match_id, kind: c.kind as HandballChangeKind,
      old_starts_at: c.old_starts_at, new_starts_at: c.new_starts_at, detected_at: c.detected_at,
    }));
}

/**
 * Die Aufstellung eines Spiels aufheben — die Zahlen, die die Quelle je
 * Spiel liefert und die bis zum 26.09.2026 nur für die eine Endstand-
 * Nachricht gelesen wurden. Grundlage der Spielerbilanz.
 */
export function storeLineup(teamId: string, matchId: string, seite: HandballLineupSide): void {
  const now = new Date().toISOString();
  for (const p of seite.players) {
    if (!p.playerId) continue;
    db.insert(handball_match_player)
      .values({
        id: `${teamId}:${matchId}:${p.playerId}`, team_id: teamId, match_id: matchId, player_id: p.playerId,
        number: p.number, is_goalkeeper: p.isGoalkeeper, is_captain: p.isCaptain, goals: p.goals, seven_meter_goals: p.sevenMeterGoals,
        seven_meter_attempts: p.sevenMeterAttempts, two_minutes: p.twoMinutes, updated_at: now,
      })
      .onConflictDoUpdate({
        target: handball_match_player.id,
        set: {
          number: p.number, is_goalkeeper: p.isGoalkeeper, is_captain: p.isCaptain, goals: p.goals, seven_meter_goals: p.sevenMeterGoals,
          seven_meter_attempts: p.sevenMeterAttempts, two_minutes: p.twoMinutes, updated_at: now,
        },
      })
      .run();
  }
  db.update(handball_team_match).set({ lineup_stored_at: now })
    .where(eq(handball_team_match.id, `${teamId}:${matchId}`)).run();
}

/**
 * Beendete Spiele, deren Aufstellung noch nicht aufgehoben ist — der
 * Altbestand beim ersten Lauf nach dem Umbau, sonst höchstens das Spiel vom
 * Wochenende. In Häppchen, weil ein Aufruf je Spiel ein Aufruf ist.
 */
async function aufstellungenNachholen(teamId: string): Promise<number> {
  const offen = db.select().from(handball_team_match)
    .where(and(eq(handball_team_match.team_id, teamId), eq(handball_team_match.status, 'finished'))).all()
    .filter(r => !r.lineup_stored_at)
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
    .slice(0, AUFSTELLUNGEN_JE_LAUF);
  let fetched = 0;
  for (const r of offen) {
    try {
      const lineup = await fetchLineups(r.match_id);
      fetched++;
      const seite = lineup.home.teamId === teamId ? lineup.home : lineup.away.teamId === teamId ? lineup.away : null;
      if (seite) storeLineup(teamId, r.match_id, seite);
      else db.update(handball_team_match).set({ lineup_stored_at: new Date().toISOString() }).where(eq(handball_team_match.id, r.id)).run();
    } catch (err) {
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, `[handball] Aufstellung für Spiel ${r.match_id} nicht abrufbar`);
    }
  }
  return fetched;
}

export interface HandballPlayerStats {
  playerId: string;
  name: string;
  /** Die zuletzt getragene Nummer. */
  number: number;
  games: number;
  goals: number;
  sevenMeterGoals: number;
  sevenMeterAttempts: number;
  twoMinutes: number;
}

/**
 * Die Saisonbilanz je Spieler aus den gespeicherten Aufstellungen — Tore
 * zuerst, dann Name. Der Name kommt aus dem Kader über die ID; wer dort
 * nicht steht, heißt „Nr. N".
 */
export function playerStats(teamId: string, opts: { excludeMatchId?: string } = {}): HandballPlayerStats[] {
  const namen = new Map(rosterFor(teamId).map(r => [r.playerId, r.name]));
  const zeilen = db.select().from(handball_match_player).where(eq(handball_match_player.team_id, teamId)).all()
    .filter(z => !opts.excludeMatchId || z.match_id !== opts.excludeMatchId)
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  const out = new Map<string, HandballPlayerStats>();
  for (const z of zeilen) {
    const bisher = out.get(z.player_id) ?? {
      playerId: z.player_id, name: namen.get(z.player_id) ?? `Nr. ${z.number}`, number: z.number,
      games: 0, goals: 0, sevenMeterGoals: 0, sevenMeterAttempts: 0, twoMinutes: 0,
    };
    bisher.number = z.number;
    bisher.games++;
    bisher.goals += z.goals;
    bisher.sevenMeterGoals += z.seven_meter_goals;
    bisher.sevenMeterAttempts += z.seven_meter_attempts;
    bisher.twoMinutes += z.two_minutes;
    out.set(z.player_id, bisher);
  }
  return [...out.values()].sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name, 'de'));
}

// ---------------------------------------------------------------------------
// Zeitzonen-Selbsttest (docs/handball-verfolgung.md §6, Grenze 2)
// ---------------------------------------------------------------------------

/**
 * Das Urteil über die Lesart „Ortszeit mit UTC-Etikett" (§3, Punkt 2),
 * einmal je Spiel beim Wechsel auf beendet:
 * - `confirmed` — der beobachtete Anwurf liegt unter 15 Minuten neben dem gespeicherten.
 * - `suspect_late` / `suspect_early` — er liegt 50 bis 135 Minuten dahinter
 *   bzw. davor: Das ist die Spanne, in der ein falsch gelesenes Etikett läge
 *   (Berliner Versatz 60 Minuten im Winter, 120 im Sommer), samt der
 *   Unschärfe der Beobachtung.
 * - `inconclusive` — dazwischen, oder die Beobachtung war zu grob.
 */
export type ZeitzonenUrteil = 'confirmed' | 'suspect_early' | 'suspect_late' | 'inconclusive';

/** Anwurf bis „beendet" bei handball.net: 2 × 25 Minuten, Pause, Unterbrechungen, Abschluss durch den Zeitnehmer. */
export const ANWURF_BIS_BEENDET_MIN = 70;
/** Breiter darf das Fenster zwischen „zuletzt unbeendet" und „zuerst beendet" nicht sein, sonst sagt es nichts. */
const STATUSFENSTER_MAX_MIN = 40;
const BESTAETIGT_UNTER_MIN = 15;
const VERDACHT_AB_MIN = 50;
const VERDACHT_BIS_MIN = 135;

export interface ZeitzonenPruefung {
  urteil: ZeitzonenUrteil;
  /** Beobachteter minus gespeicherter Anwurf in Minuten; positiv heißt: später als gespeichert. */
  abweichungMin: number | null;
  grundlage: 'torfolge' | 'statuswechsel' | null;
}

/**
 * Reine Funktion: Wo lag der Anwurf wirklich, gemessen an dem, was die
 * Instanz gesehen hat? Die Quelle liefert **keine** Uhrzeit je Ereignis und
 * kein Feld „Anwurf tatsächlich" (geprüft an `RawEvent` und den Fixtures:
 * nur `minute`, `global_minute`, `block`, `score`). Zwei Grundlagen, die
 * erste gewinnt:
 * 1. **Torfolge**: `kickoff_estimated_at`, gerechnet als Abrufzeit minus
 *    Spielminute des jüngsten Ereignisses (Halbzeit-Blick des Bots, `/live`).
 * 2. **Statuswechsel**: die Mitte zwischen „zuletzt unbeendet" und „zuerst
 *    beendet" gesehen, minus 70 Minuten. Gröber — der Zeitnehmer schließt
 *    den Bericht unterschiedlich schnell —, deshalb nur, wenn das Fenster
 *    höchstens 40 Minuten breit ist.
 */
export function pruefeZeitzone(e: {
  startsAt: string;
  kickoffEstimatedAt?: string | null;
  unfinishedSeenAt?: string | null;
  finishedSeenAt?: string | null;
}): ZeitzonenPruefung {
  const start = Date.parse(e.startsAt);
  let beobachtet: number | null = null;
  let grundlage: ZeitzonenPruefung['grundlage'] = null;
  if (e.kickoffEstimatedAt) {
    beobachtet = Date.parse(e.kickoffEstimatedAt);
    grundlage = 'torfolge';
  } else if (e.unfinishedSeenAt && e.finishedSeenAt) {
    const von = Date.parse(e.unfinishedSeenAt);
    const bis = Date.parse(e.finishedSeenAt);
    if (bis > von && bis - von <= STATUSFENSTER_MAX_MIN * 60_000) {
      beobachtet = (von + bis) / 2 - ANWURF_BIS_BEENDET_MIN * 60_000;
      grundlage = 'statuswechsel';
    }
  }
  if (beobachtet === null || !Number.isFinite(beobachtet) || !Number.isFinite(start)) {
    return { urteil: 'inconclusive', abweichungMin: null, grundlage: null };
  }
  const abweichung = Math.round((beobachtet - start) / 60_000);
  const betrag = Math.abs(abweichung);
  const urteil: ZeitzonenUrteil = betrag < BESTAETIGT_UNTER_MIN ? 'confirmed'
    : betrag >= VERDACHT_AB_MIN && betrag <= VERDACHT_BIS_MIN ? (abweichung > 0 ? 'suspect_late' : 'suspect_early')
    : 'inconclusive';
  return { urteil, abweichungMin: abweichung, grundlage };
}

/** Der Satz für `sync_error` und `/status` — mit Richtung. */
export function zeitzonenMeldung(p: ZeitzonenPruefung): string {
  const min = Math.abs(p.abweichungMin ?? 0);
  const richtung = (p.abweichungMin ?? 0) > 0 ? 'hinter' : 'vor';
  const woher = p.grundlage === 'torfolge' ? 'Die Torfolge' : 'Der Statuswechsel auf beendet';
  return `Zeitzonen-Lesart vermutlich falsch: ${woher} liegt ${min} min ${richtung} dem gespeicherten Anwurf — handball.net meint die Uhrzeit womöglich doch als UTC (docs/handball-verfolgung.md §3, Punkt 2).`;
}

/**
 * Den Anwurf aus einer live gelesenen Torfolge schätzen und am Spiel
 * merken: Abrufzeit minus Spielminute. Weil die Spieluhr hinter der Wanduhr
 * zurückbleibt (Pause, Auszeiten), ist das eine obere Grenze — deshalb
 * bleibt die früheste Schätzung stehen.
 */
export function merkeAnwurfSchaetzung(teamId: string, matchId: string, events: HandballMatchEvents, now = new Date()): void {
  if (events.count === 0 || events.latestGlobalMinute === null || events.latestGlobalMinute < 0) return;
  const row = db.select().from(handball_team_match).where(eq(handball_team_match.id, `${teamId}:${matchId}`)).get();
  if (!row || row.status === 'finished') return;
  // In der zweiten Halbzeit liegt die Pause zwischen Anwurf und Spielminute.
  const pause = events.latestGlobalMinute > 25 ? 10 : 0;
  const schaetzung = new Date(now.getTime() - (events.latestGlobalMinute + pause) * 60_000).toISOString();
  if (row.kickoff_estimated_at && row.kickoff_estimated_at <= schaetzung) return;
  db.update(handball_team_match).set({ kickoff_estimated_at: schaetzung }).where(eq(handball_team_match.id, row.id)).run();
}

/**
 * Das Urteil für ein gerade beendetes Spiel schreiben — einmal. Ein Verdacht
 * geht über `sync_error` an alle, aber nur beim **ersten** Spiel mit
 * Verdacht: Wenn die Lesart falsch ist, ist sie es bei jedem Spiel, und
 * dieselbe Meldung jeden Samstag hilft niemandem.
 */
function bewerteZeitzone(teamId: string, id: string): void {
  const row = db.select().from(handball_team_match).where(eq(handball_team_match.id, id)).get();
  if (!row || row.tz_check) return;
  const p = pruefeZeitzone({
    startsAt: row.starts_at, kickoffEstimatedAt: row.kickoff_estimated_at,
    unfinishedSeenAt: row.unfinished_seen_at, finishedSeenAt: row.finished_seen_at,
  });
  const schonVerdacht = db.select({ c: handball_team_match.tz_check }).from(handball_team_match).all()
    .some(r => r.c === 'suspect_late' || r.c === 'suspect_early');
  db.update(handball_team_match).set({ tz_check: p.urteil }).where(eq(handball_team_match.id, id)).run();
  if ((p.urteil === 'suspect_late' || p.urteil === 'suspect_early') && !schonVerdacht) {
    const text = zeitzonenMeldung(p);
    serviceLog.warn(`[handball] ${text} (Team ${teamId}, Spiel ${row.match_id})`);
    void meldeBetreiber(`${HANDBALL_KIND}:zeitzone`, HANDBALL_LABEL, text);
  }
}

export interface ZeitzonenStand {
  stand: 'bestätigt' | 'ungeprüft' | 'Verdacht';
  detail: string | null;
}

/**
 * Für `/status`: Verdacht schlägt Bestätigung — ein einziges Spiel, das eine
 * Stunde daneben lag, ist die Nachricht, auch nach drei passenden.
 */
export function zeitzonenStand(): ZeitzonenStand {
  const rows = db.select().from(handball_team_match).all().filter(r => r.tz_check)
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  const verdacht = rows.find(r => r.tz_check === 'suspect_late' || r.tz_check === 'suspect_early');
  if (verdacht) {
    const p = pruefeZeitzone({ startsAt: verdacht.starts_at, kickoffEstimatedAt: verdacht.kickoff_estimated_at, unfinishedSeenAt: verdacht.unfinished_seen_at, finishedSeenAt: verdacht.finished_seen_at });
    const min = Math.abs(p.abweichungMin ?? 0);
    return { stand: 'Verdacht', detail: `${min} min ${(p.abweichungMin ?? 0) > 0 ? 'später' : 'früher'} als gespeichert (${verdacht.home_name} – ${verdacht.away_name})` };
  }
  const bestaetigt = rows.filter(r => r.tz_check === 'confirmed').length;
  if (bestaetigt > 0) return { stand: 'bestätigt', detail: `an ${bestaetigt} Spiel${bestaetigt === 1 ? '' : 'en'}` };
  const offen = rows.filter(r => r.tz_check === 'inconclusive').length;
  return { stand: 'ungeprüft', detail: offen > 0 ? `${offen} Spiel${offen === 1 ? '' : 'e'} ohne eindeutige Beobachtung` : null };
}

// ---------------------------------------------------------------------------
// Wertung und Saisonende
// ---------------------------------------------------------------------------

/**
 * Ein Spiel, das die Quelle nicht auf beendet setzt, aber gewertet führt:
 * Abbruch, Nichtantreten mit späterer Wertung. Bis zum 27.09.2026 blieb es
 * ohne Endstand-Meldung (§6, Grenze 4). Zwei Belege, einer genügt:
 * ein Ergebnis bei Status „other"/„cancelled", oder die Tabelle zählt für
 * die eigene Mannschaft mehr Spiele, als beendete Zeilen in der Staffel
 * stehen — dann gelten die ältesten vergangenen „other"/„cancelled"-Spiele
 * als gewertet, so viele, wie fehlen.
 */
export function gewerteteSpiele(
  teamId: string,
  spiele: Array<{ match_id: string; status: string; starts_at: string; phase_id: number | null; score_home: number | null; score_away: number | null }>,
  tabellen: Array<{ phase_id: number; rows: HandballStandingRow[] }>,
  jetzt = Date.now(),
): Set<string> {
  const kandidat = (m: (typeof spiele)[number]) => (m.status === 'other' || m.status === 'cancelled') && Date.parse(m.starts_at) < jetzt;
  const out = new Set<string>();
  for (const m of spiele) if (kandidat(m) && m.score_home !== null && m.score_away !== null) out.add(m.match_id);
  for (const t of tabellen) {
    const eigene = t.rows.find(r => r.teamId === teamId);
    if (!eigene) continue;
    const inStaffel = spiele.filter(m => m.phase_id === t.phase_id);
    const gezaehlt = inStaffel.filter(m => m.status === 'finished' || out.has(m.match_id)).length;
    let fehlen = eigene.played - gezaehlt;
    for (const m of inStaffel.filter(x => kandidat(x) && !out.has(x.match_id)).sort((a, b) => a.starts_at.localeCompare(b.starts_at))) {
      if (fehlen <= 0) break;
      out.add(m.match_id);
      fehlen--;
    }
  }
  return out;
}

/** Wie lange nach dem letzten Spiel die Saisonkarte noch geht — danach ist es Rückblick, keine Nachricht. */
export const SAISONKARTE_MAX_ALTER_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Frühestens so lange nach dem letzten Anwurf: nicht direkt hinter Endstand
 * und Spielbericht, sondern am Morgen danach — und bis dahin hat die Quelle
 * die Tabelle nachgezogen, aus der der Endplatz kommt.
 */
export const SAISONKARTE_MIN_ALTER_MS = 12 * 60 * 60 * 1000;

/**
 * Ist die Saison einer Mannschaft vorbei? Ja, wenn jedes Spiel beendet,
 * gewertet oder abgesetzt ist — und mindestens eines gespielt wurde.
 * `frisch` sagt zusätzlich, ob das letzte gespielte mindestens zwölf Stunden
 * und höchstens sieben Tage her ist: nur dann geht die Saisonkarte von sich
 * aus raus. Ein verlegtes
 * Nachholspiel hält die Saison offen, auch wenn es erst im Juni ist.
 */
export function saisonVorbei(team: Pick<HandballTeamView, 'matches'>, now = new Date()): { vorbei: boolean; frisch: boolean; letztes: string | null } {
  const spiele = team.matches;
  const fertig = (m: HandballMatchView) => m.status === 'finished' || m.status === 'cancelled' || m.rated;
  const gespielt = spiele.filter(m => m.status === 'finished' || m.rated);
  if (spiele.length === 0 || gespielt.length === 0 || !spiele.every(fertig)) return { vorbei: false, frisch: false, letztes: null };
  const letztes = gespielt.map(m => m.starts_at).sort().at(-1)!;
  const alter = now.getTime() - Date.parse(letztes);
  return { vorbei: true, frisch: alter >= SAISONKARTE_MIN_ALTER_MS && alter <= SAISONKARTE_MAX_ALTER_MS, letztes };
}

/** Halbzeitstand am Spiel merken — kommt aus der Torfolge, gesehen vom Bot. */
export function setzeHalbzeit(teamId: string, matchId: string, home: number, away: number): void {
  db.update(handball_team_match).set({ halftime_home: home, halftime_away: away })
    .where(eq(handball_team_match.id, `${teamId}:${matchId}`)).run();
}

/** Spielbericht am Spiel ablegen — `/bericht` liest ihn von hier. */
export function setzeBericht(teamId: string, matchId: string, text: string): void {
  db.update(handball_team_match).set({ report_text: text })
    .where(eq(handball_team_match.id, `${teamId}:${matchId}`)).run();
}

/** Torfolge am Spiel ablegen — `[]` heißt ausdrücklich „geholt, es gibt keine". */
export function setzeTorfolge(teamId: string, matchId: string, events: HandballMatchEventItem[]): void {
  db.update(handball_team_match).set({ events_payload: JSON.stringify(events) })
    .where(eq(handball_team_match.id, `${teamId}:${matchId}`)).run();
}

function torfolgeAusZeile(payload: string | null): HandballMatchEventItem[] | null {
  if (!payload) return null;
  try {
    const roh = JSON.parse(payload) as unknown;
    return Array.isArray(roh) ? (roh as HandballMatchEventItem[]) : null;
  } catch {
    return null;
  }
}

/**
 * Torfolgen beendeter Spiele nachholen, in jedem Takt, höchstens drei: Der
 * Spielverlauf auf der Microsite (docs/handball-verfolgung.md §7.5) liest
 * sie aus der Datenbank — eine öffentliche Seite darf keinen Abruf nach
 * draußen auslösen. Eine leere Antwort und ein 404 werden als `[]`
 * gespeichert, damit ein Spiel ohne Torfolge (gewertet, abgebrochen) nicht
 * bei jedem Takt erneut gefragt wird; ein Leitungsfehler bleibt null.
 */
async function torfolgenNachholen(teamId: string): Promise<number> {
  const offen = db.select().from(handball_team_match)
    .where(and(eq(handball_team_match.team_id, teamId), eq(handball_team_match.status, 'finished'))).all()
    .filter(r => r.events_payload === null)
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
    .slice(0, TORFOLGEN_JE_LAUF);
  let fetched = 0;
  for (const r of offen) {
    try {
      const events = await fetchMatchEventList(r.match_id);
      fetched++;
      setzeTorfolge(teamId, r.match_id, events);
    } catch (err) {
      fetched++;
      const message = err instanceof Error ? err.message : String(err);
      if (/HTTP 404/.test(message)) setzeTorfolge(teamId, r.match_id, []);
      else serviceLog.warn({ err: message }, `[handball] Torfolge für Spiel ${r.match_id} nicht abrufbar`);
    }
  }
  return fetched;
}

/**
 * Spielberichte nachholen, einmal je Tageslauf: Der Bot holt den Bericht nur
 * zu Spielen, deren Endstand er selbst gemeldet hat (§5) — ohne Bot oder
 * nach einem Ausfall bliebe die Microsite ohne. Nur Spiele der letzten 30
 * Tage, höchstens drei je Lauf; ein Spiel ohne Bericht bei der Quelle kostet
 * damit einen Aufruf am Tag, dreißig Tage lang, dann Ruhe.
 */
async function berichteNachholen(teamId: string, now = Date.now()): Promise<number> {
  const offen = db.select().from(handball_team_match)
    .where(and(eq(handball_team_match.team_id, teamId), eq(handball_team_match.status, 'finished'))).all()
    .filter(r => !r.report_text && now - Date.parse(r.starts_at) < BERICHT_NACHFRAGEN_BIS_MS && now - Date.parse(r.starts_at) > 75 * 60 * 1000)
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
    .slice(0, BERICHTE_JE_TAGESLAUF);
  let fetched = 0;
  for (const r of offen) {
    try {
      const text = await fetchMatchReport(r.match_id);
      fetched++;
      if (text) setzeBericht(teamId, r.match_id, text);
    } catch (err) {
      fetched++;
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, `[handball] Spielbericht für Spiel ${r.match_id} nicht abrufbar`);
    }
  }
  return fetched;
}

/**
 * Der Spielplan des nächsten Gegners, einmal je Tageslauf: seine letzten
 * Ergebnisse stehen nicht in der eigenen Datenbank, und die Microsite darf
 * sie nicht selbst holen. Eine Zeile je Gegner; ein alter Eintrag bleibt
 * stehen, wenn der Abruf scheitert (nach bestem Bemühen, wie in der
 * Ankündigung des Bots).
 */
async function gegnerSpielplanHolen(teamId: string, seasonId: number): Promise<number> {
  const jetzt = Date.now();
  const naechstes = db.select().from(handball_team_match)
    .where(eq(handball_team_match.team_id, teamId)).all()
    .filter(r => r.status === 'scheduled' && Date.parse(r.starts_at) + NACHFASSEN_BIS_MS > jetzt)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
  if (!naechstes) return 0;
  const gegner = naechstes.home_id === teamId ? naechstes.away_id : naechstes.home_id;
  // Testspiele gegen Mannschaften außerhalb von handball.net tragen die ID 0 — die Quelle antwortet darauf mit 422.
  if (!gegner || gegner === '0') return 0;
  try {
    const spiele = await fetchTeamMatches(gegner, seasonId);
    const now = new Date().toISOString();
    db.insert(handball_opponent_form)
      .values({ team_id: gegner, season_id: seasonId, payload: JSON.stringify(spiele), fetched_at: now })
      .onConflictDoUpdate({ target: handball_opponent_form.team_id, set: { season_id: seasonId, payload: JSON.stringify(spiele), fetched_at: now } })
      .run();
  } catch (err) {
    serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, `[handball] Spielplan des Gegners ${gegner} nicht abrufbar`);
  }
  return 1;
}

/** Der gespeicherte Spielplan eines Gegners — null, solange der Tageslauf ihn nie geholt hat. */
export function opponentFormFor(opponentId: string): { matches: HandballMatch[]; fetched_at: string } | null {
  const row = db.select().from(handball_opponent_form).where(eq(handball_opponent_form.team_id, opponentId)).get();
  if (!row) return null;
  try {
    const roh = JSON.parse(row.payload) as unknown;
    return Array.isArray(roh) ? { matches: roh as HandballMatch[], fetched_at: row.fetched_at } : null;
  } catch {
    return null;
  }
}

/**
 * Den Spielbericht sicherstellen: gespeichert zurückgeben, sonst einmal
 * holen und ablegen. Die eine Ausnahme von „kein Aufruf für einen Befehl":
 * Ein Bericht zu einem Spiel, dessen Endstand der Bot nie gemeldet hat
 * (vor dem Einrichten, vor dem Umbau), käme sonst nie — und mehr als ein
 * Aufruf je Spiel wird es nicht, weil der Text danach dasteht.
 */
export async function ensureMatchReport(teamId: string, matchId: string): Promise<string | null> {
  const row = db.select().from(handball_team_match).where(eq(handball_team_match.id, `${teamId}:${matchId}`)).get();
  if (!row || row.status !== 'finished') return null;
  if (row.report_text) return row.report_text;
  const text = await fetchMatchReport(matchId);
  if (text) setzeBericht(teamId, matchId, text);
  return text;
}

/**
 * Tabelle ablegen — und den Stand davor behalten, wenn er sich geändert hat:
 * „von 3 auf 2 geklettert" im Endstand und die Tendenzpfeile im Bild
 * brauchen den Vergleich. Ein unveränderter Abruf (der Tageslauf ohne
 * Spieltag) überschreibt den Vorstand nicht.
 */
function upsertStandings(phaseId: number, seasonId: number, competitionName: string, rows: HandballStandingRow[], history: HandballStandingRow[] = []): void {
  const now = new Date().toISOString();
  const payload = JSON.stringify(rows);
  const historyPayload = history.length > 0 ? JSON.stringify(history) : null;
  const existing = db.select().from(handball_standings).where(eq(handball_standings.phase_id, phaseId)).get();
  if (!existing) {
    db.insert(handball_standings)
      .values({ phase_id: phaseId, season_id: seasonId, competition_name: competitionName, payload, fetched_at: now, history_payload: historyPayload })
      .run();
    return;
  }
  const geaendert = existing.payload !== payload;
  db.update(handball_standings)
    .set({
      season_id: seasonId, competition_name: competitionName, payload, fetched_at: now,
      // Ein leerer Verlauf überschreibt keinen vorhandenen — die Quelle nennt ihn bei jedem Abruf ganz.
      ...(historyPayload ? { history_payload: historyPayload } : {}),
      ...(geaendert ? { previous_payload: existing.payload, previous_fetched_at: existing.fetched_at } : {}),
    })
    .where(eq(handball_standings.phase_id, phaseId))
    .run();
}

/** Staffeln, in denen eine Mannschaft spielt — aus ihren gespeicherten Spielen. */
function phasenVon(teamId: string): Array<{ phaseId: number; seasonId: number; name: string }> {
  const rows = db.select().from(handball_team_match).where(eq(handball_team_match.team_id, teamId)).all();
  const out = new Map<number, { phaseId: number; seasonId: number; name: string }>();
  for (const r of rows) {
    if (r.phase_id !== null && !out.has(r.phase_id)) {
      out.set(r.phase_id, { phaseId: r.phase_id, seasonId: r.season_id, name: r.competition_name });
    }
  }
  return [...out.values()];
}

async function tabellenHolen(teamId: string): Promise<number> {
  let fetched = 0;
  for (const phase of phasenVon(teamId)) {
    try {
      const { current, history } = await fetchStandingsWithHistory(phase.phaseId, phase.seasonId);
      fetched++;
      upsertStandings(phase.phaseId, phase.seasonId, phase.name, current, history);
    } catch (err) {
      // Ein Pokal ohne Tabelle ist keine leere Tabelle, sondern keine.
      if (err instanceof Error && err.name === 'HandballEmptyError') continue;
      throw err;
    }
  }
  return fetched;
}

/**
 * Kader nach bestem Bemühen: Ohne ihn stehen in den Bot-Texten Nummern statt
 * Namen — kein Grund, den Lauf rot zu machen. Ein Spieler, der aus dem Kader
 * verschwindet, bleibt in der Tabelle; ein alter Name ist besser als „Nr. 29".
 */
async function kaderHolen(teamId: string, seasonId: number): Promise<number> {
  try {
    const kader = await fetchRoster(teamId, seasonId);
    const now = new Date().toISOString();
    for (const e of kader) {
      db.insert(handball_roster)
        .values({
          id: `${teamId}:${e.playerId}`, team_id: teamId, player_id: e.playerId,
          first_name: e.firstName, last_name: e.lastName, number: e.number, role: e.role,
          season_id: seasonId, updated_at: now,
        })
        .onConflictDoUpdate({
          target: handball_roster.id,
          set: { first_name: e.firstName, last_name: e.lastName, number: e.number, role: e.role, season_id: seasonId, updated_at: now },
        })
        .run();
    }
    return 1;
  } catch (err) {
    serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, `[handball] Kader für Team ${teamId} nicht abrufbar`);
    return 1;
  }
}

/**
 * Das Vereinslogo nach bestem Bemühen: einmal geholt, dreißig Tage behalten,
 * bei neuer URL erneut. Nur von den Logo-Hosts der Quelle, über `safeFetch`
 * — die URL kommt aus einer fremden Antwort und wäre sonst ein SSRF-Weg.
 */
function logoFehlt(teamId: string, url: string): boolean {
  const vorhanden = db.select().from(handball_team_logo).where(eq(handball_team_logo.team_id, teamId)).get();
  return !vorhanden || vorhanden.source_url !== url || Date.now() - Date.parse(vorhanden.fetched_at) >= LOGO_TTL_MS;
}

async function logoHolen(teamId: string, url: string | null): Promise<number> {
  if (!url || !logoFehlt(teamId, url)) return 0;
  try {
    const bild = await safeFetchImage(url, {
      allowHost: u => HANDBALL_LOGO_HOSTS.includes(u.hostname),
      maxBytes: 2 * 1024 * 1024,
    });
    const now = new Date().toISOString();
    db.insert(handball_team_logo)
      .values({ team_id: teamId, source_url: url, mime_type: bild.mimeType, image: bild.buffer, fetched_at: now })
      .onConflictDoUpdate({ target: handball_team_logo.team_id, set: { source_url: url, mime_type: bild.mimeType, image: bild.buffer, fetched_at: now } })
      .run();
  } catch (err) {
    serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, `[handball] Logo für Team ${teamId} nicht abrufbar`);
  }
  return 1;
}

/**
 * Die Logos aller Mannschaften im gespeicherten Spielplan — die eigene und
 * jeder Gegner, damit die Endstand-Karte beide zeigt. Läuft in jedem Takt
 * und kostet nichts, solange alles da ist; je Lauf höchstens zehn, damit der
 * erste Tag nach dem Umbau keine Salve wird. Aus der Datenbank statt aus
 * der frischen Antwort, damit es nicht am Tageslauf hängt (der am 27.09.2026
 * vor dem Deploy schon gelaufen war — und `/spieler` bis zum nächsten Tag
 * „noch keine Aufstellung" sagte).
 */
async function logosNachholen(teamId: string): Promise<number> {
  const urls = new Map<string, string>();
  for (const r of db.select().from(handball_team_match).where(eq(handball_team_match.team_id, teamId)).all()) {
    if (r.home_id && r.home_logo_url && !urls.has(r.home_id)) urls.set(r.home_id, r.home_logo_url);
    if (r.away_id && r.away_logo_url && !urls.has(r.away_id)) urls.set(r.away_id, r.away_logo_url);
  }
  let fetched = 0;
  for (const [id, url] of urls) {
    if (fetched >= LOGOS_JE_LAUF) break;
    fetched += await logoHolen(id, url);
  }
  return fetched;
}

/** Was noch nachzuholen ist — für `/status` des Betreibers. */
export function backlogFor(teamId: string): { lineupsMissing: number; logosMissing: number } {
  const rows = db.select().from(handball_team_match).where(eq(handball_team_match.team_id, teamId)).all();
  const lineupsMissing = rows.filter(r => r.status === 'finished' && !r.lineup_stored_at).length;
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.home_logo_url) ids.add(r.home_id);
    if (r.away_logo_url) ids.add(r.away_id);
  }
  const vorhanden = new Set(db.select({ id: handball_team_logo.team_id }).from(handball_team_logo).all().map(r => r.id));
  const logosMissing = [...ids].filter(id => !vorhanden.has(id)).length;
  return { lineupsMissing, logosMissing };
}

/** Das gespeicherte Logo als Data-URI für die SVG-Bilder — null, wenn keins da ist. */
export function logoDataUri(teamId: string): string | null {
  const row = db.select().from(handball_team_logo).where(eq(handball_team_logo.team_id, teamId)).get();
  if (!row) return null;
  return `data:${row.mime_type};base64,${Buffer.from(row.image).toString('base64')}`;
}

export interface HandballRosterName {
  playerId: string;
  name: string;
  number: number | null;
  /** Woher die Nummer kommt: aus dem Kader, oder zuletzt im Spiel getragen (Kader ohne Nummer). */
  numberSource: 'roster' | 'lineup' | null;
  /** In mindestens einer gespeicherten Aufstellung als Torwart. */
  goalkeeper: boolean;
  /** In der letzten gespeicherten Aufstellung als Kapitän. */
  captain: boolean;
  role: 'player' | 'staff';
}

/** Je Spieler: zuletzt getragene Nummer, ob er je im Tor stand und ob er zuletzt Kapitän war — aus den aufgehobenen Aufstellungen. */
function aufstellungsMerkmale(teamId: string): Map<string, { number: number; goalkeeper: boolean; captain: boolean }> {
  const start = new Map(db.select({ id: handball_team_match.match_id, s: handball_team_match.starts_at }).from(handball_team_match)
    .where(eq(handball_team_match.team_id, teamId)).all().map(r => [r.id, r.s]));
  const zeilen = db.select().from(handball_match_player).where(eq(handball_match_player.team_id, teamId)).all()
    .sort((a, b) => (start.get(a.match_id) ?? '').localeCompare(start.get(b.match_id) ?? ''));
  const out = new Map<string, { number: number; goalkeeper: boolean; captain: boolean }>();
  for (const z of zeilen) {
    const bisher = out.get(z.player_id);
    // Torwart: je einmal genügt. Kapitän: nur die letzte Aufstellung zählt — die Binde wandert.
    out.set(z.player_id, { number: z.number, goalkeeper: (bisher?.goalkeeper ?? false) || z.is_goalkeeper, captain: z.is_captain });
  }
  return out;
}

/**
 * Der gespeicherte Kader einer Mannschaft — Spieler zuerst, nach Nummer,
 * dann Stab. Wer im Kader ohne Nummer steht, aber gespielt hat, bekommt die
 * zuletzt getragene aus der Aufstellung (drei von neunzehn am 27.09.2026);
 * wer je im Tor stand, ist als Torwart markiert.
 */
export function rosterFor(teamId: string): HandballRosterName[] {
  const merkmale = aufstellungsMerkmale(teamId);
  return db.select().from(handball_roster).where(eq(handball_roster.team_id, teamId)).all()
    .map(r => {
      const m = merkmale.get(r.player_id);
      const number = r.number ?? m?.number ?? null;
      return {
        playerId: r.player_id,
        name: `${r.first_name} ${r.last_name}`.trim() || `Nr. ${number ?? '?'}`,
        number,
        numberSource: r.number !== null ? 'roster' as const : m ? 'lineup' as const : null,
        goalkeeper: m?.goalkeeper ?? false,
        captain: m?.captain ?? false,
        role: r.role === 'staff' ? 'staff' as const : 'player' as const,
      };
    })
    .sort((a, b) => (a.role === b.role ? (a.number ?? 999) - (b.number ?? 999) : a.role === 'player' ? -1 : 1));
}

/** Bester Torschütze je Spiel — für die Ergebnisliste. */
export function matchTopScorers(teamId: string): Map<string, { name: string; goals: number }> {
  const namen = new Map(rosterFor(teamId).map(r => [r.playerId, r.name]));
  const out = new Map<string, { name: string; goals: number }>();
  for (const z of db.select().from(handball_match_player).where(eq(handball_match_player.team_id, teamId)).all()) {
    if (z.goals <= 0) continue;
    const bisher = out.get(z.match_id);
    if (!bisher || z.goals > bisher.goals) out.set(z.match_id, { name: namen.get(z.player_id) ?? `Nr. ${z.number}`, goals: z.goals });
  }
  return out;
}

export interface HandballPlayerMatch {
  matchId: string;
  startsAt: string;
  opponent: string;
  /** Team-ID des Gegners — für sein Logo unter dem Balken. */
  opponentId: string | null;
  isHome: boolean;
  goals: number;
}

/** Der Verlauf eines Spielers über die Saison — Tore je Spiel, chronologisch. */
export function playerMatchLog(teamId: string, playerId: string): HandballPlayerMatch[] {
  const spiele = new Map(db.select().from(handball_team_match).where(eq(handball_team_match.team_id, teamId)).all().map(r => [r.match_id, r]));
  return db.select().from(handball_match_player).where(and(eq(handball_match_player.team_id, teamId), eq(handball_match_player.player_id, playerId))).all()
    .map(z => {
      const m = spiele.get(z.match_id);
      const heim = m ? m.home_id === teamId : true;
      return { matchId: z.match_id, startsAt: m?.starts_at ?? '', opponent: m ? (heim ? m.away_name : m.home_name) : '?', opponentId: m ? (heim ? m.away_id : m.home_id) : null, isHome: heim, goals: z.goals };
    })
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export interface HandballPlayerGame {
  playerId: string;
  name: string;
  number: number;
  matchId: string;
  goals: number;
  sevenMeterGoals: number;
  twoMinutes: number;
}

/**
 * Jede gespeicherte Aufstellungszeile mit Namen — die Rohform für `/rekorde`
 * („meiste Tore eines Spielers in einem Spiel"). Sortiert nach Toren, dann
 * nach Name, damit ein Gleichstand stabil bleibt.
 */
export function playerGames(teamId: string): HandballPlayerGame[] {
  const namen = new Map(rosterFor(teamId).map(r => [r.playerId, r.name]));
  return db.select().from(handball_match_player).where(eq(handball_match_player.team_id, teamId)).all()
    .map(z => ({
      playerId: z.player_id, name: namen.get(z.player_id) ?? `Nr. ${z.number}`, number: z.number,
      matchId: z.match_id, goals: z.goals, sevenMeterGoals: z.seven_meter_goals, twoMinutes: z.two_minutes,
    }))
    .sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name, 'de'));
}

export interface HandballPositionPoint {
  round: number;
  position: number;
  points: number;
  /** Wie viele Mannschaften in der Staffel — die Untergrenze der Achse. */
  teams: number;
}

/**
 * Der Tabellenplatz je gespieltem Spieltag aus der Historie (`history_rows`)
 * — eine Zeile je Spieltag, aufsteigend. Leer, solange der Verlauf noch nie
 * geholt wurde (Spalte seit Migration 0097, der nächste Tageslauf füllt sie).
 */
export function positionHistory(standings: HandballStandingsView, teamId: string): HandballPositionPoint[] {
  const jeRunde = new Map<number, HandballStandingRow[]>();
  for (const r of standings.history_rows) {
    const liste = jeRunde.get(r.round) ?? [];
    liste.push(r);
    jeRunde.set(r.round, liste);
  }
  const out: HandballPositionPoint[] = [];
  for (const runde of [...jeRunde.keys()].sort((a, b) => a - b)) {
    const zeilen = jeRunde.get(runde)!;
    const eigene = zeilen.find(r => r.teamId === teamId);
    if (!eigene) continue;
    out.push({ round: runde, position: eigene.position, points: eigene.points, teams: zeilen.length });
  }
  return out;
}

/**
 * Der Stand, gegen den Tendenzpfeile und „von 3 auf 2 geklettert" gemessen
 * werden: die Tabelle **nach dem vorigen Spieltag** aus der Historie — nicht
 * der letzte Abruf, der anders aussah (`previous_rows`).
 *
 * Der Unterschied ist kein Detail. Am 28.09.2026 stand ein ▼ neben den
 * Wölfen, die auf Platz 2 geblieben waren: Sie hatten am Samstag gespielt,
 * der Tabellenführer erst am Sonntag, und der Abruf dazwischen sah sie kurz
 * auf 1. Gegen diesen Zwischenstand gemessen war der Sonntag ein Abstieg —
 * gegen den Stand nach dem 2. Spieltag ein Verharren. Ein Zwischenstand
 * während eines Spieltags ist kein Stand, gegen den sich etwas bewegt.
 *
 * Null, solange es keinen vorigen Spieltag gibt (erster Spieltag) oder die
 * Historie noch nie geholt wurde — dann gibt es keine Pfeile; wer den alten
 * Vergleich als Rückfall will, nimmt `previous_rows` selbst.
 */
export function tendenzReferenz(standings: HandballStandingsView): HandballStandingRow[] | null {
  const spieltag = standings.rows[0]?.round ?? 0;
  if (spieltag < 2) return null;
  const vorig = standings.history_rows.filter(r => r.round === spieltag - 1);
  return vorig.length > 0 ? vorig : null;
}

export interface HandballSyncResult {
  status: 'ok' | 'not_configured' | 'auth_error' | 'transient_error';
  teams: number;
  fetched: number;
  detail?: string;
}

/**
 * Ein Lauf des Hintergrund-Jobs. `force` überspringt die Tagesprüfung — für
 * den Knopf in den Diensten und die Aktualisierung im Tab.
 */
export async function syncHandballTeams(force = false): Promise<HandballSyncResult> {
  const teams = readTeamIds();
  if (teams.length === 0) return { status: 'not_configured', teams: 0, fetched: 0 };

  const heute = berlinDay();
  const jetzt = Date.now();
  let fetched = 0;

  const alleZeilen = db.select().from(handball_team_match).all();
  // `updated_at` ist UTC, `heute` der Berliner Tag — beide im selben
  // Kalender vergleichen, sonst läuft der Tageslauf zwischen 0 und 2 Uhr
  // bei jedem Takt erneut (die Lehre aus lib/dartsFavourites.ts).
  // Je Mannschaft: Eine später in TEAM_IDS ergänzte Mannschaft wartet sonst
  // bis zum nächsten Tag, weil die erste heute schon Zeilen hat.
  const heuteGeholt = new Set(alleZeilen.filter(r => berlinDay(new Date(r.updated_at)) === heute).map(r => r.team_id));
  const faellig = force ? teams : teams.filter(t => !heuteGeholt.has(t));
  // Eine leere Antwort betrifft nur ihre Mannschaft (falsche Team-ID) — die
  // übrigen werden trotzdem geholt, der Fehler meldet sich danach.
  let teamFehler: unknown = null;

  try {
    // --- Teil 1: der Tageslauf ----------------------------------------------
    if (faellig.length > 0) {
      const saison = await fetchActiveSeason();
      fetched++;
      for (const teamId of faellig) {
        let spiele: HandballMatch[];
        try {
          spiele = await fetchTeamMatches(teamId, saison.id);
        } catch (err) {
          if (!(err instanceof HandballEmptyError)) throw err;
          fetched++;
          teamFehler ??= err;
          continue;
        }
        fetched++;
        for (const m of spiele) upsertMatch(teamId, m);
        fetched += await tabellenHolen(teamId);
        fetched += await kaderHolen(teamId, saison.id);
        fetched += await gegnerSpielplanHolen(teamId, saison.id);
        fetched += await berichteNachholen(teamId, jetzt);
      }
    }

    // --- Teil 1b: Altbestand nachholen, in jedem Takt -------------------------
    // Aufstellungen beendeter Spiele und Vereinslogos, die noch fehlen. Ohne
    // Fehlbestand kostet das keinen Aufruf; mit hängt es bewusst nicht am
    // Tageslauf, damit ein Umbau nicht bis morgen wartet.
    for (const teamId of teams) {
      fetched += await aufstellungenNachholen(teamId);
      fetched += await logosNachholen(teamId);
      fetched += await torfolgenNachholen(teamId);
    }

    // --- Teil 2: am Spieltag nachfassen ---------------------------------------
    // Nur für Mannschaften, deren Spiel läuft oder durch sein müsste. An
    // einem Tag ohne Spiel passiert hier nichts.
    const nachzufassen = [...new Set(
      db.select().from(handball_team_match).all()
        .filter(r => (r.status === 'scheduled' || r.status === 'live' || r.status === 'other')
          && jetzt - Date.parse(r.starts_at) >= NACHFASSEN_AB_MS
          && jetzt - Date.parse(r.starts_at) < NACHFASSEN_BIS_MS)
        .map(r => r.team_id),
    )].filter(teamId => teams.includes(teamId));

    for (const teamId of nachzufassen) {
      const saisonId = db.select({ s: handball_team_match.season_id }).from(handball_team_match)
        .where(eq(handball_team_match.team_id, teamId)).get()?.s;
      if (!saisonId) continue;
      const vorher = db.select().from(handball_team_match)
        .where(and(eq(handball_team_match.team_id, teamId), eq(handball_team_match.status, 'finished'))).all().length;
      const spiele = await fetchTeamMatches(teamId, saisonId);
      fetched++;
      for (const m of spiele) upsertMatch(teamId, m);
      const nachher = db.select().from(handball_team_match)
        .where(and(eq(handball_team_match.team_id, teamId), eq(handball_team_match.status, 'finished'))).all().length;
      // Ein neu beendetes Spiel ändert die Tabelle — einmal nachholen, nicht je Tick.
      if (nachher > vorher) fetched += await tabellenHolen(teamId);
    }
    if (teamFehler) throw teamFehler;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = klassifiziereHandballFehler(err);
    const isAuth = status === 'auth_error';
    const { consecutiveFailures, logAsError } = backoff.recordFailure(BACKOFF_KEY, isAuth ? AUTH_BACKOFF_MS : TRANSIENT_BACKOFF_MS);
    const line = `[handball] ${isAuth ? 'Zugangsfehler' : 'Vorübergehender Fehler'} (#${consecutiveFailures}): ${message}`;
    if (logAsError) serviceLog.error(line); else serviceLog.warn(line);
    lastError = message;
    // Eine leere Antwort oder ein 403 erholt sich nicht von selbst und meldet
    // sofort; ein Zucken der Leitung erst ab dem dritten Lauf, wie in Todoteck
    // — nur geht die Meldung hier an die Admin-Chats des Bots (lib/alerts.ts).
    if (isAuth || consecutiveFailures >= DEFAULT_LOG_THRESHOLD) {
      void meldeBetreiber(HANDBALL_KIND, HANDBALL_LABEL, `${isAuth ? 'Zugangsfehler' : `Vorübergehender Fehler (#${consecutiveFailures})`}: ${message}`);
    }
    return { status, teams: teams.length, fetched, detail: message };
  }

  backoff.recordSuccess(BACKOFF_KEY);
  lastError = null;
  entwarnung(HANDBALL_KIND);
  return { status: 'ok', teams: teams.length, fetched };
}

/** Die Sicht der verfolgten Mannschaft auf ein Spiel. */
function ausTeamSicht(r: typeof handball_team_match.$inferSelect) {
  const heim = r.home_id === r.team_id;
  return {
    heim,
    eigenerName: heim ? r.home_name : r.away_name,
    gegner: heim ? r.away_name : r.home_name,
    eigeneTore: heim ? r.score_home : r.score_away,
    gegnerTore: heim ? r.score_away : r.score_home,
  };
}

// ---------------------------------------------------------------------------
// Sicht für den Tab
// ---------------------------------------------------------------------------

export interface HandballMatchView {
  match_id: string;
  season_id: number;
  starts_at: string;
  status: string;
  status_name: string;
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

export interface HandballTeamView {
  team_id: string;
  name: string;
  /**
   * Wie die Mannschaft neben den anderen des Vereins heißt — im Dropdown der
   * Microsite und in der Auswahl des Bots: der Name aus `TEAM_IDS`, sonst
   * `automatischesLabel` („2. Herren", „mB-Jugend"), sonst die Altersklasse
   * der Quelle („B-Jugend"), sonst der Mannschaftsname.
   * Tragen zwei Mannschaften verschiedene Namen (zweite Mannschaft), steht
   * der Name davor.
   */
  label: string;
  championship_name: string | null;
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
    round: r.round,
    competition_name: r.competition_name,
    home_id: r.home_id,
    home_name: r.home_name,
    away_id: r.away_id,
    away_name: r.away_name,
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
 * Der Name im Dropdown, aus den Daten der Quelle gelesen — so, wie der Verein
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
 * Der Tab liest ausschließlich die Datenbank — **kein** Aufruf nach draußen.
 * Gefüllt hat sie der Job; steht dort nichts, sagt der Tab das.
 */
export function handballOverview(): HandballOverview {
  const teams = readTeamIds();
  if (teams.length === 0) return { configured: false, teams: [], updated_at: null };

  const alle = teams.length > 0
    ? db.select().from(handball_team_match).where(inArray(handball_team_match.team_id, teams)).all()
    : [];
  const tabellen = db.select().from(handball_standings).all();
  const jetzt = Date.now();
  let updatedAt: string | null = null;

  const views = teams.map(teamId => {
    const meine = alle.filter(r => r.team_id === teamId).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    for (const r of meine) if (!updatedAt || r.updated_at > updatedAt) updatedAt = r.updated_at;
    const erste = meine[0];
    const name = erste ? (erste.home_id === teamId ? erste.home_name : erste.away_name) : `Team ${teamId}`;
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
        return { phase_id: t.phase_id, competition_name: t.competition_name, fetched_at: t.fetched_at, rows, previous_rows: previous, history_rows: history };
      });
    const gewertet = gewerteteSpiele(teamId, meine, standings, jetzt);
    const zuletzt = meine.filter(r => r.status === 'finished' || gewertet.has(r.match_id));
    return {
      team_id: teamId,
      name,
      label: teamLabelAusConfig(teamId) ?? automatischesLabel(name, meine) ?? erste?.championship_name ?? name,
      championship_name: erste?.championship_name ?? null,
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
