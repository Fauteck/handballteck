/**
 * Die Texte und Tastaturen des Handball-Bots — alles, was aus einer Mannschafts-
 * oder Spielsicht eine Nachricht (Telegram-HTML) oder eine Tastatur macht, ohne
 * etwas zu senden. Rein und ohne Zustand, deshalb das, was man testet; der
 * Bot (`handballBot.ts`) führt sie aus und reicht sie weiter.
 */

import { escapeHtml, type InlineKeyboard } from './telegramClient';
import { type HandballLineup, type HandballLineupSide, type HandballMatch, type HandballMatchEvents } from './handballNetClient';
import {
  rosterFor, matchTopScorers, playerMatchLog, tendenzReferenz, type HandballMatchView, type HandballTeamView, type HandballStandingsView,
  type HandballChangeView, type HandballPlayerStats, type HandballRosterName, type HandballPlayerGame,
} from './handballTeam';
import type { HandballVenue } from './handballBot';

// ---------------------------------------------------------------------------
// Texte — exportiert, weil sie das sind, was man testet
// ---------------------------------------------------------------------------

/** Der Bot, wie Telegram ihn kennt — von der Registrierung gesetzt, für die Fußzeile der Bilder und den Einladungslink gelesen. */
export const botIdentity: { username: string | null } = { username: null };

export const DATUM_KURZ = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' });
export const DATUM = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'Europe/Berlin' });
export const DATUM_MIT_JAHR = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' });
/** Ab diesem Abstand steht das Jahr dabei — in der Winterpause wird „Sa., 12.09." sonst mehrdeutig. */
export const JAHR_AB_MS = 60 * 24 * 60 * 60 * 1000;

export function datum(d: Date, now: Date): string {
  return Math.abs(d.getTime() - now.getTime()) > JAHR_AB_MS ? DATUM_MIT_JAHR.format(d) : DATUM.format(d);
}
export const DATUM_LANG = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'Europe/Berlin' });
export const ZEIT = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });

export function gegnerVon(m: HandballMatchView): string {
  return m.is_home ? m.away_name : m.home_name;
}

export function wo(m: HandballMatchView): string {
  return m.round ? `${m.competition_name}, ${m.round}. Spieltag` : m.competition_name;
}

function heuteOderDatum(start: Date, now: Date): string {
  const tag = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return tag(start) === tag(now) ? 'heute' : `am ${DATUM_LANG.format(start)}`;
}

export function gegnerId(m: HandballMatchView): string {
  return m.is_home ? m.away_id : m.home_id;
}

/**
 * Zwei Zeilen zum Gegner, aus dem, was schon da ist: seine Zeile in der
 * gespeicherten Tabelle, das Hinspiel aus dem eigenen Spielplan — und, wenn
 * der Aufrufer sie mitbringt, seine letzten drei Ergebnisse (ein Abruf seines
 * Spielplans, eine Stunde vor dem Anwurf; nach bestem Bemühen).
 */
export function gegnerSteckbrief(team: HandballTeamView, m: HandballMatchView, gegnerSpiele: HandballMatch[] | null = null): string[] {
  const gid = gegnerId(m);
  const zeilen: string[] = [];
  const zeile = team.standings.flatMap(s => s.rows).find(r => r.teamId === gid);
  if (zeile) {
    zeilen.push(`Gegner: ${zeile.position}. Platz · ${zeile.won}-${zeile.drawn}-${zeile.lost} · ${zeile.goalsFor}:${zeile.goalsAgainst} Tore · ${zeile.points} Pkt`);
  }
  if (gegnerSpiele) {
    const letzte = gegnerSpiele
      .filter(g => g.status === 'finished' && g.scoreHome !== null && g.scoreAway !== null && g.id !== m.match_id)
      .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
      .slice(0, 3)
      .map(g => {
        const heim = g.homeId === gid;
        const eigene = heim ? g.scoreHome! : g.scoreAway!;
        const andere = heim ? g.scoreAway! : g.scoreHome!;
        const zeichen = eigene > andere ? '✅' : eigene < andere ? '❌' : '➖';
        return `${zeichen} ${eigene}:${andere} ${heim ? 'gegen' : 'bei'} ${escapeHtml(heim ? g.awayName : g.homeName)}`;
      });
    if (letzte.length > 0) zeilen.push(`Zuletzt: ${letzte.join(' · ')}`);
  }
  // Direktvergleich: alle bisherigen Duelle der Saison, nicht nur das Hinspiel.
  const duelle = team.matches.filter(h => h.match_id !== m.match_id && h.status === 'finished' && gegnerId(h) === gid
    && h.score_home !== null && h.score_away !== null);
  if (duelle.length > 0) {
    const eintrag = duelle.map(h => {
      const eigene = h.is_home ? h.score_home : h.score_away;
      const andere = h.is_home ? h.score_away : h.score_home;
      return `${eigene}:${andere} (${h.is_home ? 'H' : 'A'})`;
    });
    zeilen.push(`${duelle.length === 1 ? 'Hinspiel' : 'Bisher'}: ${eintrag.join(' · ')}`);
  }
  return zeilen;
}

export function textAnkuendigung(team: HandballTeamView, m: HandballMatchView, now = new Date(), gegnerSpiele: HandballMatch[] | null = null): string {
  const start = new Date(m.starts_at);
  const zeilen = [
    `🤾 <b>${escapeHtml(team.name)}</b> spielt ${heuteOderDatum(start, now)} um ${ZEIT.format(start)} Uhr`,
    m.is_home ? `gegen ${escapeHtml(gegnerVon(m))} (Heimspiel)` : `bei ${escapeHtml(gegnerVon(m))}`,
  ];
  const halle = [m.venue_name, m.venue_address].filter(Boolean).join(', ');
  if (halle) zeilen.push(`📍 ${escapeHtml(halle)}`);
  zeilen.push(escapeHtml(wo(m)));
  const steckbrief = gegnerSteckbrief(team, m, gegnerSpiele);
  if (steckbrief.length > 0) zeilen.push('', ...steckbrief);
  return zeilen.join('\n');
}

const BERLIN_TAG = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Europe/Berlin' });
const BERLIN_STUNDE = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Berlin' });
/** Ab dieser Berliner Stunde kommt der Spieltagsgruß — nicht vor dem Frühstück. */
const SPIELTAGSGRUSS_AB_STUNDE = 8;
/** Bis zum Anwurf muss mindestens so viel Zeit sein, sonst übernimmt die Ankündigung. */
const SPIELTAGSGRUSS_MIN_VORLAUF_MS = 4 * 60 * 60 * 1000;

/** Ob jetzt der Gruß am Spieltagsmorgen fällig ist: Anwurf heute, es ist nach acht Uhr, und bis dahin ist noch Zeit. */
export function spieltagsGrussFaellig(m: HandballMatchView, now: Date): boolean {
  const start = new Date(m.starts_at);
  if (BERLIN_TAG.format(start) !== BERLIN_TAG.format(now)) return false;
  if (Number(BERLIN_STUNDE.format(now)) < SPIELTAGSGRUSS_AB_STUNDE) return false;
  return start.getTime() - now.getTime() >= SPIELTAGSGRUSS_MIN_VORLAUF_MS;
}

/** Der Morgengruß am Spieltag: wann, wo, gegen wen — und der Steckbrief des Gegners. */
export function textSpieltag(team: HandballTeamView, m: HandballMatchView, gegnerSpiele: HandballMatch[] | null = null): string {
  const start = new Date(m.starts_at);
  const zeilen = [
    `☀️ <b>Spieltag!</b> ${escapeHtml(team.name)} spielt heute um ${ZEIT.format(start)} Uhr`,
    m.is_home ? `gegen ${escapeHtml(gegnerVon(m))} (Heimspiel)` : `bei ${escapeHtml(gegnerVon(m))}`,
  ];
  const halle = [m.venue_name, m.venue_address].filter(Boolean).join(', ');
  if (halle) zeilen.push(`📍 ${escapeHtml(halle)}`);
  const steckbrief = gegnerSteckbrief(team, m, gegnerSpiele);
  if (steckbrief.length > 0) zeilen.push('', ...steckbrief);
  return zeilen.join('\n');
}

/**
 * Der Routen-Knopf unter der Ankündigung: Koordinaten der Halle, wie die
 * Quelle sie führt; ohne Koordinaten die Anschrift als Suchbegriff. Zwei
 * Ziele, weil nicht jedes Telefon Google Maps hat.
 */
export function routenTastatur(m: HandballMatchView): InlineKeyboard | null {
  if (m.venue_lat !== null && m.venue_lon !== null) {
    const ziel = `${m.venue_lat},${m.venue_lon}`;
    return { inline_keyboard: [[
      { text: '🗺 Route (Google Maps)', url: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(ziel)}` },
      { text: 'OpenStreetMap', url: `https://www.openstreetmap.org/?mlat=${m.venue_lat}&mlon=${m.venue_lon}#map=16/${m.venue_lat}/${m.venue_lon}` },
    ]] };
  }
  if (m.venue_address) {
    return { inline_keyboard: [[
      { text: '🗺 Route (Google Maps)', url: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(m.venue_address)}` },
    ]] };
  }
  return null;
}

/** Die Halle eines Spiels als Ort — nur mit Koordinaten; Telegram verlangt Name und Anschrift. */
export function halleAlsOrt(m: HandballMatchView): HandballVenue | null {
  if (m.venue_lat === null || m.venue_lon === null) return null;
  const title = m.venue_name || 'Halle';
  return { latitude: m.venue_lat, longitude: m.venue_lon, title, address: m.venue_address || title };
}

/**
 * Der Knopf „📍 Halle" — schickt die Halle als Ort, den das Telefon in der
 * Karten-App öffnet. Mit der Spiel-ID, solange sie in Telegrams 64 Byte
 * passt, sonst ohne (dann gilt das nächste Spiel).
 */
function halleKnopf(m: HandballMatchView): { text: string; callback_data: string } {
  const mitId = knopf('📍 Halle', 'halle', m.match_id);
  return Buffer.byteLength(mitId.callback_data, 'utf8') <= 64 && /^[\w.:-]+$/.test(m.match_id) ? mitId : knopf('📍 Halle', 'halle');
}

/** Unter der Karte zum nächsten Spiel: Route und, mit Koordinaten, der Halle-Knopf. */
export function spielTastatur(m: HandballMatchView): InlineKeyboard | null {
  const route = routenTastatur(m)?.inline_keyboard ?? [];
  const zeilen = halleAlsOrt(m) ? [...route, [halleKnopf(m)]] : route;
  return zeilen.length > 0 ? { inline_keyboard: zeilen } : null;
}

export function textHalbzeit(team: HandballTeamView, m: HandballMatchView, halbzeit: { home: number; away: number }): string {
  const eigene = m.is_home ? halbzeit.home : halbzeit.away;
  const andere = m.is_home ? halbzeit.away : halbzeit.home;
  const lage = eigene > andere ? 'vorn' : eigene < andere ? 'hinten' : 'gleichauf';
  return `⏸ <b>Halbzeit: ${escapeHtml(team.name)} ${eigene}:${andere}</b> ${m.is_home ? 'gegen' : 'bei'} ${escapeHtml(gegnerVon(m))} — ${lage}`;
}

export function textAenderung(team: HandballTeamView, m: HandballMatchView, c: HandballChangeView): string {
  const alt = new Date(c.old_starts_at);
  const neu = new Date(c.new_starts_at);
  const wann = (d: Date) => `${DATUM_LANG.format(d)}, ${ZEIT.format(d)} Uhr`;
  const paarung = `${escapeHtml(team.name)} ${m.is_home ? 'gegen' : 'bei'} ${escapeHtml(gegnerVon(m))}`;
  if (c.kind === 'cancelled') {
    return `❌ <b>Spiel abgesetzt:</b> ${paarung}\nwar angesetzt für ${wann(alt)} · ${escapeHtml(wo(m))}`;
  }
  if (c.kind === 'postponed') {
    return `📅 <b>Spiel verschoben:</b> ${paarung}\nwar angesetzt für ${wann(alt)} — ein neuer Termin steht noch nicht fest.`;
  }
  const halle = [m.venue_name, m.venue_address].filter(Boolean).join(', ');
  return [
    `📅 <b>Spiel verlegt:</b> ${paarung}`,
    `ursprünglich ${wann(alt)}`,
    `jetzt <b>${wann(neu)}</b>${halle ? ` · 📍 ${escapeHtml(halle)}` : ''}`,
  ].join('\n');
}

/**
 * Der Spielbericht der Quelle als Nachricht: eigene Kopfzeile mit Endstand,
 * die „## "-Zwischenüberschriften fett, am Ende der Spielberichtsbogen.
 */
/**
 * handball.net schreibt den Bericht in Titelschreibung („Hsg Wölfe Voreifel",
 * „Tv Palmersheim Ii", „Peter-weber-halle Kuchenheim", „B-jugend -
 * Kreisoberliga Mb"). Die richtigen Schreibweisen stehen in der Datenbank:
 * Mannschaften, Halle, Wettbewerb, Altersklasse — hier werden sie
 * unabhängig von Groß/Klein wiederhergestellt. Was die Datenbank nicht
 * kennt, bleibt, wie es kommt.
 */
export function berichtGlaetten(text: string, m: HandballMatchView, championship: string | null): string {
  const namen = [m.home_name, m.away_name, m.venue_name, m.competition_name, championship]
    .filter((n): n is string => !!n && n.length >= 4)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const n of namen) {
    const muster = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi');
    out = out.replace(muster, n);
  }
  return out;
}

/**
 * Der Bericht in zwei Längen: `kurz` ist Kopfzeile plus der letzte Abschnitt
 * (bei handball.net „Fazit") — am Telefon eine Nachricht statt vier
 * Bildschirme; der Knopf „Ganzer Bericht" (`cmd:bericht:voll`) holt den Rest.
 */
export function textBericht(team: HandballTeamView, m: HandballMatchView, laenge: 'kurz' | 'voll' = 'voll'): string {
  const eigene = m.is_home ? m.score_home : m.score_away;
  const andere = m.is_home ? m.score_away : m.score_home;
  const kopf = `📰 <b>Spielbericht: ${escapeHtml(team.name)} ${eigene ?? '–'}:${andere ?? '–'} ${m.is_home ? 'gegen' : 'bei'} ${escapeHtml(gegnerVon(m))}</b>`;
  const roh = berichtGlaetten(m.report_text ?? '', m, team.championship_name).split(/\n\n+/).map(a => a.trim()).filter(Boolean);
  let auswahl = roh;
  if (laenge === 'kurz') {
    // Der letzte Abschnitt ab seiner Überschrift; ohne Überschriften der letzte Absatz.
    const letzteUeberschrift = roh.map((a, i) => (a.startsWith('## ') ? i : -1)).filter(i => i >= 0).pop();
    auswahl = letzteUeberschrift !== undefined ? roh.slice(letzteUeberschrift) : roh.slice(-1);
    if (auswahl.length < roh.length) auswahl = [...auswahl, `<i>Gekürzt — der ganze Bericht über den Knopf.</i>`];
  }
  const absaetze = auswahl.map(a => (a.startsWith('<i>') ? a : a.startsWith('## ') ? `<b>${escapeHtml(a.slice(3))}</b>` : escapeHtml(a)));
  const fuss = m.report_url ? `<a href="${escapeHtml(m.report_url)}">Spielberichtsbogen (PDF)</a>` : `<a href="${m.url}">Spielseite auf handball.net</a>`;
  return [kopf, ...absaetze, fuss].join('\n\n');
}

/** Knöpfe unter dem gekürzten Bericht: erst „Ganzer Bericht", dann die übliche Leiste. */
export function berichtTastatur(m: HandballMatchView, gekuerzt: boolean): InlineKeyboard {
  const rest = endstandTastatur(m).inline_keyboard;
  return { inline_keyboard: gekuerzt ? [[knopf('📄 Ganzer Bericht', 'bericht', 'voll')], ...rest] : rest };
}

function bilanzZeile(p: HandballPlayerStats): string {
  const teile = [`${p.goals} Tore in ${p.games} Spiel${p.games === 1 ? '' : 'en'}`];
  if (p.sevenMeterAttempts > 0) teile.push(`${p.sevenMeterGoals}/${p.sevenMeterAttempts} Siebenmeter`);
  if (p.twoMinutes > 0) teile.push(`${p.twoMinutes}× 2 min`);
  return teile.join(' · ');
}

/** Auf wen ein Name passt: Teil des Namens, Groß/Klein egal, oder die Nummer. */
export function spielerTreffer(stats: HandballPlayerStats[], suche: string): HandballPlayerStats[] {
  const q = suche.trim().toLowerCase();
  if (!q) return [];
  return stats.filter(p => p.playerId === suche.trim() || p.name.toLowerCase().includes(q) || String(p.number) === q);
}

/**
 * `/spieler` ohne Namen: die Torschützenliste der Saison. Mit Namen: die
 * Bilanz derer, auf die der Name passt (Teil des Namens, Groß/Klein egal) —
 * bei mehreren Treffern alle, kurz.
 */
export function textSpieler(team: HandballTeamView, stats: HandballPlayerStats[], suche: string): string {
  if (stats.length === 0) {
    return `<b>${escapeHtml(team.name)}</b>\nNoch keine Aufstellung gespeichert — sie kommt mit dem nächsten Spiel (und der Altbestand mit dem nächsten Tageslauf).`;
  }
  const q = suche.trim().toLowerCase();
  const schnitt = (p: HandballPlayerStats) => (p.goals / Math.max(1, p.games)).toFixed(1).replace('.', ',');
  if (!q) {
    const zeilen = stats.filter(p => p.goals > 0).slice(0, 10)
      .map((p, i) => `${i + 1}. ${escapeHtml(p.name)} — ${p.goals} (${p.games} Sp., ${schnitt(p)}/Spiel)`);
    return [
      `<b>${escapeHtml(team.name)}</b> — Torschützen der Saison`,
      ...(zeilen.length > 0 ? zeilen : ['Noch kein Tor gespeichert.']),
      'Für einen Spieler: /spieler Name',
    ].join('\n');
  }
  const treffer = spielerTreffer(stats, suche);
  if (treffer.length === 0) return `Zu „${escapeHtml(suche.trim())}" habe ich keinen Spieler mit Einsatz in dieser Saison.`;
  if (treffer.length === 1) {
    const p = treffer[0];
    const verlauf = playerMatchLog(team.team_id, p.playerId);
    const zeilen = [`<b>${escapeHtml(p.name)}</b> (Nr. ${p.number}) — ${escapeHtml(team.name)}`, `${bilanzZeile(p)} · ${schnitt(p)} pro Spiel`];
    if (verlauf.length > 1) zeilen.push(`Tore je Spiel: ${verlauf.map(v => String(v.goals)).join(' · ')}`);
    const bestes = [...verlauf].sort((a, b) => b.goals - a.goals)[0];
    if (bestes && bestes.goals > 0 && verlauf.length > 1) zeilen.push(`Bestes Spiel: ${bestes.goals} ${bestes.isHome ? 'gegen' : 'bei'} ${escapeHtml(bestes.opponent)}`);
    return zeilen.join('\n');
  }
  return treffer.slice(0, 8).map(p => `<b>${escapeHtml(p.name)}</b> — ${bilanzZeile(p)}`).join('\n');
}

export function eigeneSeite(lineup: HandballLineup, teamId: string): HandballLineupSide | null {
  if (lineup.home.teamId === teamId) return lineup.home;
  if (lineup.away.teamId === teamId) return lineup.away;
  return null;
}

/** Name aus dem Kader über die ID; ohne Treffer bleibt die Nummer. */
export type NameLookup = (playerId: string) => string | null;

export function namenAus(teamId: string): NameLookup {
  const kader = new Map(rosterFor(teamId).map(r => [r.playerId, r.name]));
  return id => kader.get(id) ?? null;
}

export function spieler(p: { playerId: string; number: number; isGoalkeeper: boolean; isCaptain: boolean }, name: NameLookup): string {
  const zusatz = [p.isGoalkeeper ? 'TW' : null, p.isCaptain ? 'C' : null].filter(Boolean).join(', ');
  const n = name(p.playerId);
  const kern = n ? `${p.number} ${escapeHtml(n)}` : `Nr. ${p.number}`;
  return zusatz ? `${kern} (${zusatz})` : kern;
}

export function textAufstellung(team: HandballTeamView, m: HandballMatchView, seite: HandballLineupSide, name: NameLookup = namenAus(team.team_id)): string {
  const ohneNamen = seite.players.filter(p => !name(p.playerId)).length;
  const zeilen = [
    `📋 <b>Aufstellung ${escapeHtml(team.name)}</b> ${m.is_home ? 'gegen' : 'bei'} ${escapeHtml(gegnerVon(m))}`,
    seite.players.map(p => spieler(p, name)).join('\n'),
    `${seite.players.length} Spieler${seite.staffCount > 0 ? `, ${seite.staffCount} an der Bank` : ''}`,
  ];
  if (ohneNamen === seite.players.length) {
    zeilen.push('Namen fehlen noch — der Kader wird beim nächsten Tageslauf geholt.');
  }
  return zeilen.join('\n');
}

/**
 * „Weiter Platz 1, Vorsprung 3 Punkte" / „von 3 auf 2 geklettert" — aus dem
 * Vergleich der gespeicherten Tabelle mit ihrem Stand davor. Null, solange
 * es keinen Vorstand gibt oder die Tabelle sich nicht bewegt hat.
 */
export function tabellenBewegung(team: HandballTeamView): string | null {
  const s = team.standings[0];
  if (!s) return null;
  // Gemessen am Stand nach dem vorigen Spieltag (`tendenzReferenz`); der
  // letzte geänderte Abruf bleibt der Rückfall für Tabellen ohne Verlauf.
  const referenz = tendenzReferenz(s) ?? s.previous_rows;
  if (!referenz) return null;
  const jetzt = s.rows.find(r => r.teamId === team.team_id);
  const davor = referenz.find(r => r.teamId === team.team_id);
  if (!jetzt || !davor || jetzt.played === davor.played) return null;
  const teile: string[] = [];
  if (jetzt.position === davor.position) teile.push(`weiter Platz ${jetzt.position}`);
  else if (jetzt.position < davor.position) teile.push(`von Platz ${davor.position} auf ${jetzt.position} geklettert`);
  else teile.push(`von Platz ${davor.position} auf ${jetzt.position} gerutscht`);
  if (jetzt.position === 1) {
    const zweiter = s.rows.find(r => r.position === 2);
    if (zweiter) teile.push(`Vorsprung ${jetzt.points - zweiter.points} Punkt${jetzt.points - zweiter.points === 1 ? '' : 'e'}`);
  } else {
    const erster = s.rows.find(r => r.position === 1);
    if (erster) teile.push(`${erster.points - jetzt.points} Punkt${erster.points - jetzt.points === 1 ? '' : 'e'} hinter Platz 1`);
  }
  const text = teile.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface EndstandExtras {
  /** Bilanz der Spieler **vor** diesem Spiel — für „erstes Saisontor". */
  vorher?: HandballPlayerStats[] | null;
  bewegung?: string | null;
}

export function textEndstand(team: HandballTeamView, m: HandballMatchView, seite: HandballLineupSide | null, name: NameLookup = namenAus(team.team_id), extras: EndstandExtras = {}): string {
  const eigene = m.is_home ? m.score_home : m.score_away;
  const gegner = m.is_home ? m.score_away : m.score_home;
  const stand = `${eigene ?? '–'}:${gegner ?? '–'}`;
  const ohneStand = eigene === null || gegner === null;
  const ausgang = ohneStand ? 'Spiel gewertet' : m.won === true ? 'gewinnt' : m.won === false ? 'verliert' : 'spielt unentschieden';
  const zusatz = m.rated ? ' (gewertet)' : '';
  const zeilen = [
    ohneStand
      ? `🏁 <b>${escapeHtml(team.name)}: Spiel gewertet</b> ${m.is_home ? 'gegen' : 'bei'} ${escapeHtml(gegnerVon(m))}`
      : `🏁 <b>${escapeHtml(team.name)} ${ausgang} ${stand}${zusatz}</b> ${m.is_home ? 'gegen' : 'bei'} ${escapeHtml(gegnerVon(m))}`,
  ];
  if (m.rated) {
    zeilen.push(ohneStand
      ? `handball.net hat das Spiel nicht zu Ende gemeldet („${escapeHtml(m.status_name || m.status)}"), die Tabelle zählt es aber — das Ergebnis steht dort noch nicht.`
      : `handball.net führt das Spiel als „${escapeHtml(m.status_name || m.status)}", aber mit Ergebnis — Abbruch oder Nichtantreten, von der Spielleitung gewertet.`);
  }
  if (m.halftime_home !== null && m.halftime_away !== null) {
    zeilen.push(`Halbzeit ${m.is_home ? m.halftime_home : m.halftime_away}:${m.is_home ? m.halftime_away : m.halftime_home}`);
  }
  const schuetzen = (seite?.players ?? []).filter(p => p.goals > 0).sort((a, b) => b.goals - a.goals || a.number - b.number);
  const wer = (p: { playerId: string; number: number }) => { const n = name(p.playerId); return n ? escapeHtml(n) : `Nr. ${p.number}`; };
  if (schuetzen.length > 0) {
    zeilen.push(`Tore: ${schuetzen.map(p => `${wer(p)} ${p.goals}${p.sevenMeterGoals > 0 ? ` (${p.sevenMeterGoals}× 7m)` : ''}`).join(', ')}`);
    // Spieler des Spiels: der beste Torschütze, mit Siebenmeter-Quote, wenn er welche hatte.
    const bester = schuetzen[0];
    const quote = bester.sevenMeterAttempts > 0 ? `, ${bester.sevenMeterGoals}/${bester.sevenMeterAttempts} Siebenmeter` : '';
    zeilen.push(`⭐ Spieler des Spiels: ${wer(bester)} mit ${bester.goals} Tor${bester.goals === 1 ? '' : 'en'}${quote}`);
    if (extras.vorher && extras.vorher.length > 0) {
      const bisherige = new Map(extras.vorher.map(p => [p.playerId, p.goals]));
      const erste = schuetzen.filter(p => (bisherige.get(p.playerId) ?? 0) === 0 && bisherige.has(p.playerId)).map(wer);
      if (erste.length > 0) zeilen.push(`🎯 Erstes Saisontor: ${erste.join(', ')}`);
    }
  }
  if (extras.bewegung) zeilen.push(`📊 ${escapeHtml(extras.bewegung)}`);
  zeilen.push(escapeHtml(wo(m)));
  zeilen.push(`<a href="${m.url}">Spielseite auf handball.net</a>`);
  return zeilen.join('\n');
}

/**
 * Die Saisonbilanz aus dem gespeicherten Spielplan — Siege, Tore, Heim gegen
 * Auswärts, höchster Sieg, längste Serie. Nichts davon braucht einen Abruf.
 */
/** Ein Bot-Text ohne Telegram-HTML — für den Cockpit-Tab, der Zeilen statt Markup zeigt. */
export function alsKlartext(html: string): string[] {
  return html.replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .split('\n').map(z => z.trimEnd()).filter(z => z.length > 0);
}

/** 27,7 statt 27.7 — Zahlen im Bot sind deutsch. */
export function komma(n: number): string {
  return n.toFixed(1).replace('.', ',');
}

/**
 * `/rekorde`: die Bestmarken der Saison aus dem gespeicherten Spielplan und
 * den aufgehobenen Aufstellungen. Was `/saison` schon nennt (höchster Sieg,
 * längste Serie), steht hier noch einmal — die Liste soll für sich stehen.
 */
export function textRekorde(team: HandballTeamView, spiele: HandballPlayerGame[], now = new Date()): string {
  const gespielt = team.matches.filter(m => m.status === 'finished' && m.score_home !== null && m.score_away !== null);
  if (gespielt.length === 0) return `<b>${escapeHtml(team.name)}</b>\nNoch kein Spiel in dieser Saison — Rekorde gibt es ab dem ersten.`;
  const eigene = (m: HandballMatchView) => (m.is_home ? m.score_home! : m.score_away!);
  const andere = (m: HandballMatchView) => (m.is_home ? m.score_away! : m.score_home!);
  const wann = (m: HandballMatchView) => `${eigene(m)}:${andere(m)} ${m.is_home ? 'gegen' : 'bei'} ${escapeHtml(gegnerVon(m))} (${datum(new Date(m.starts_at), now)})`;
  const nach = (f: (m: HandballMatchView) => number, richtung: 1 | -1) => [...gespielt].sort((a, b) => richtung * (f(b) - f(a)))[0];
  const zeilen = [`🏆 <b>${escapeHtml(team.name)}</b> — Rekorde der Saison`];
  const sieg = nach(m => eigene(m) - andere(m), 1);
  if (eigene(sieg) > andere(sieg)) zeilen.push(`Höchster Sieg: ${wann(sieg)}`);
  const niederlage = nach(m => eigene(m) - andere(m), -1);
  if (eigene(niederlage) < andere(niederlage)) zeilen.push(`Höchste Niederlage: ${wann(niederlage)}`);
  zeilen.push(`Meiste eigene Tore: ${wann(nach(eigene, 1))}`);
  zeilen.push(`Wenigste Gegentore: ${wann(nach(andere, -1))}`);
  const torreich = nach(m => eigene(m) + andere(m), 1);
  zeilen.push(`Torreichstes Spiel: ${wann(torreich)} — ${eigene(torreich) + andere(torreich)} Tore`);
  const mitHz = gespielt.filter(m => m.halftime_home !== null && m.halftime_away !== null);
  if (mitHz.length > 0) {
    const eigeneHz = (m: HandballMatchView) => (m.is_home ? m.halftime_home! : m.halftime_away!);
    const andereHz = (m: HandballMatchView) => (m.is_home ? m.halftime_away! : m.halftime_home!);
    const beste = [...mitHz].sort((a, b) => (eigeneHz(b) - andereHz(b)) - (eigeneHz(a) - andereHz(a)))[0];
    zeilen.push(`Beste erste Halbzeit: ${eigeneHz(beste)}:${andereHz(beste)} ${beste.is_home ? 'gegen' : 'bei'} ${escapeHtml(gegnerVon(beste))}`);
  }
  const bestes = spiele[0];
  if (bestes && bestes.goals > 0) {
    const m = gespielt.find(x => x.match_id === bestes.matchId);
    zeilen.push(`Meiste Tore eines Spielers: ${bestes.goals} — ${escapeHtml(bestes.name)}${m ? ` ${m.is_home ? 'gegen' : 'bei'} ${escapeHtml(gegnerVon(m))}` : ''}`);
  }
  const siebener = [...spiele].sort((a, b) => b.sevenMeterGoals - a.sevenMeterGoals)[0];
  if (siebener && siebener.sevenMeterGoals > 1) zeilen.push(`Meiste Siebenmeter-Tore in einem Spiel: ${siebener.sevenMeterGoals} — ${escapeHtml(siebener.name)}`);
  let serie = 0; let laengste = 0; let ohneNiederlage = 0; let laengsteOhne = 0;
  for (const m of gespielt) {
    if (m.won === true) { serie++; laengste = Math.max(laengste, serie); } else serie = 0;
    if (m.won !== false) { ohneNiederlage++; laengsteOhne = Math.max(laengsteOhne, ohneNiederlage); } else ohneNiederlage = 0;
  }
  const laeuft = serie === laengste && laengste > 0;
  if (laengste > 1) zeilen.push(`Längste Siegesserie: ${laengste} Spiele${laeuft ? ' — läuft noch' : ''}`);
  if (laengsteOhne > laengste && laengsteOhne > 1) zeilen.push(`Längste Serie ohne Niederlage: ${laengsteOhne} Spiele${ohneNiederlage === laengsteOhne ? ' — läuft noch' : ''}`);
  return zeilen.join('\n');
}

export function textSaison(team: HandballTeamView): string {
  const gespielt = team.matches.filter(m => m.status === 'finished' && m.score_home !== null && m.score_away !== null);
  if (gespielt.length === 0) return `<b>${escapeHtml(team.name)}</b>\nNoch kein Spiel in dieser Saison.`;
  const eigene = (m: HandballMatchView) => (m.is_home ? m.score_home! : m.score_away!);
  const andere = (m: HandballMatchView) => (m.is_home ? m.score_away! : m.score_home!);
  const bilanz = (spiele: HandballMatchView[]) => {
    const s = spiele.filter(m => m.won === true).length;
    const n = spiele.filter(m => m.won === false).length;
    const u = spiele.length - s - n;
    const tf = spiele.reduce((a, m) => a + eigene(m), 0);
    const ta = spiele.reduce((a, m) => a + andere(m), 0);
    return { s, u, n, tf, ta };
  };
  const alle = bilanz(gespielt);
  const heim = bilanz(gespielt.filter(m => m.is_home));
  const ausw = bilanz(gespielt.filter(m => !m.is_home));
  const punkte = alle.s * 2 + alle.u;
  const bester = [...gespielt].sort((a, b) => (eigene(b) - andere(b)) - (eigene(a) - andere(a)))[0];
  let serie = 0; let laengste = 0; let laufend = 0;
  for (const m of gespielt) {
    if (m.won === true) { serie++; laengste = Math.max(laengste, serie); } else serie = 0;
  }
  for (let i = gespielt.length - 1; i >= 0 && gespielt[i].won === true; i--) laufend++;
  const zeilen = [
    `<b>${escapeHtml(team.name)}</b> — Saison ${team.championship_name ? escapeHtml(team.championship_name) : ''}`.trimEnd(),
    `${gespielt.length} Spiel${gespielt.length === 1 ? '' : 'e'}: ${alle.s} Siege, ${alle.u} Unentschieden, ${alle.n} Niederlagen · ${punkte}:${gespielt.length * 2 - punkte} Punkte`,
    `Tore ${alle.tf}:${alle.ta} · Schnitt ${komma(alle.tf / gespielt.length)} : ${komma(alle.ta / gespielt.length)}`,
    `Heim ${heim.s}-${heim.u}-${heim.n} (${heim.tf}:${heim.ta}) · Auswärts ${ausw.s}-${ausw.u}-${ausw.n} (${ausw.tf}:${ausw.ta})`,
  ];
  // Der Schnitt je Halbzeit — nur aus Spielen, deren Halbzeitstand der Bot gesehen hat.
  const mitHz = gespielt.filter(m => m.halftime_home !== null && m.halftime_away !== null);
  if (mitHz.length > 0) {
    const eigeneHz = (m: HandballMatchView) => (m.is_home ? m.halftime_home! : m.halftime_away!);
    const andereHz = (m: HandballMatchView) => (m.is_home ? m.halftime_away! : m.halftime_home!);
    const n = mitHz.length;
    const hz1 = { f: mitHz.reduce((a, m) => a + eigeneHz(m), 0) / n, a: mitHz.reduce((a, m) => a + andereHz(m), 0) / n };
    const hz2 = { f: mitHz.reduce((a, m) => a + eigene(m) - eigeneHz(m), 0) / n, a: mitHz.reduce((a, m) => a + andere(m) - andereHz(m), 0) / n };
    const basis = n < gespielt.length ? ` (${n} Spiel${n === 1 ? '' : 'e'} mit Halbzeitstand)` : '';
    zeilen.push(`1. Halbzeit Ø ${komma(hz1.f)}:${komma(hz1.a)} · 2. Halbzeit Ø ${komma(hz2.f)}:${komma(hz2.a)}${basis}`);
  }
  if (bester && eigene(bester) > andere(bester)) {
    zeilen.push(`Höchster Sieg: ${eigene(bester)}:${andere(bester)} ${bester.is_home ? 'gegen' : 'bei'} ${escapeHtml(gegnerVon(bester))}`);
  }
  if (laengste > 1) zeilen.push(`Längste Siegesserie: ${laengste} Spiele${laufend === laengste ? ' — und sie läuft noch' : ''}`);
  else if (laufend === 1) zeilen.push('Das letzte Spiel gewonnen.');
  const zeile = team.standings.flatMap(s => s.rows).find(r => r.teamId === team.team_id);
  if (zeile) zeilen.push(`Tabelle: Platz ${zeile.position} mit ${zeile.points} Punkten`);
  return zeilen.join('\n');
}

/** `/live`: der Zwischenstand aus der Torfolge, mit Minute und Halbzeit. */
export function textLive(team: HandballTeamView, m: HandballMatchView, events: HandballMatchEvents): string {
  if (!events.latest || events.count === 0) {
    return `⏱ ${escapeHtml(team.name)} ${m.is_home ? 'gegen' : 'bei'} ${escapeHtml(gegnerVon(m))} — die Torfolge ist noch leer, der Zeitnehmer hat noch nichts eingetragen.`;
  }
  const eigene = m.is_home ? events.latest.home : events.latest.away;
  const andere = m.is_home ? events.latest.away : events.latest.home;
  const minute = events.latestMinute ? `${events.latestMinute.split(':')[0].replace(/^0/, '')}. Minute` : null;
  const wo = [minute, events.latestBlock].filter(Boolean).join(', ');
  return `⏱ <b>${escapeHtml(team.name)} ${eigene}:${andere}</b> ${m.is_home ? 'gegen' : 'bei'} ${escapeHtml(gegnerVon(m))}${wo ? ` — ${escapeHtml(wo)}` : ''}${events.halftime ? `\nHalbzeit ${m.is_home ? events.halftime.home : events.halftime.away}:${m.is_home ? events.halftime.away : events.halftime.home}` : ''}`;
}

/**
 * Der Spielplan als Kalenderdatei (RFC 5545), zum Import ins Telefon. Eine
 * neue Datei bei jedem `/kalender`; wer sie nach einer Verlegung erneut
 * holt, bekommt dieselben UIDs mit höherer SEQUENCE, und der Kalender
 * ersetzt den Termin statt ihn zu verdoppeln.
 */
export function icsKalender(team: HandballTeamView): string {
  const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const zeilen = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Handballteck//Bot//DE', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(team.name)}`];
  for (const m of team.matches) {
    if (m.status === 'cancelled') continue;
    const start = new Date(m.starts_at);
    const ende = new Date(start.getTime() + 75 * 60 * 1000);
    const titel = `${m.home_name} – ${m.away_name}${m.status === 'postponed' ? ' (verschoben)' : ''}`;
    const ort = [m.venue_name, m.venue_address].filter(Boolean).join(', ');
    zeilen.push(
      'BEGIN:VEVENT',
      `UID:handball-${m.match_id}@todoteck`,
      `DTSTAMP:${stamp(new Date().toISOString())}`,
      `DTSTART:${stamp(start.toISOString())}`,
      `DTEND:${stamp(ende.toISOString())}`,
      `SUMMARY:${esc(titel)}`,
      ...(ort ? [`LOCATION:${esc(ort)}`] : []),
      `DESCRIPTION:${esc(`${wo(m)}\n${m.url}`)}`,
      `SEQUENCE:${Math.floor(Date.now() / 60000) % 100000}`,
      'END:VEVENT',
    );
  }
  zeilen.push('END:VCALENDAR');
  return zeilen.join('\r\n') + '\r\n';
}

export function textSpiele(teams: HandballTeamView[], now = new Date()): string {
  const bloecke = teams.map(team => {
    const kommend = team.matches
      .filter(m => (m.status === 'scheduled' || m.status === 'live') && Date.parse(m.starts_at) > now.getTime() - 3 * 60 * 60 * 1000)
      .slice(0, 5);
    if (kommend.length === 0) return `<b>${escapeHtml(team.name)}</b>\nKein Spiel angesetzt.`;
    const zeilen = kommend.map(m => {
      const start = new Date(m.starts_at);
      const ort = m.is_home ? 'H' : 'A';
      const halle = m.venue_name ? ` · ${escapeHtml(m.venue_name)}` : '';
      return `${datum(start, now)} ${ZEIT.format(start)} ${ort} ${escapeHtml(gegnerVon(m))}${halle}${m.status === 'live' ? ' · läuft' : ''}`;
    });
    return `<b>${escapeHtml(team.name)}</b> — nächste Spiele\n${zeilen.join('\n')}`;
  });
  return bloecke.join('\n\n');
}

export function textErgebnisse(teams: HandballTeamView[], now = new Date(), schuetzen: (teamId: string) => Map<string, { name: string; goals: number }> = matchTopScorers): string {
  const bloecke = teams.map(team => {
    const gespielt = team.matches.filter(m => m.status === 'finished').slice(-5).reverse();
    if (gespielt.length === 0) return `<b>${escapeHtml(team.name)}</b>\nNoch kein Ergebnis in dieser Saison.`;
    const beste = schuetzen(team.team_id);
    const zeilen = gespielt.map(m => {
      const eigene = m.is_home ? m.score_home : m.score_away;
      const gegner = m.is_home ? m.score_away : m.score_home;
      const zeichen = m.won === true ? '✅' : m.won === false ? '❌' : '➖';
      const hz = m.halftime_home !== null && m.halftime_away !== null
        ? ` (HZ ${m.is_home ? m.halftime_home : m.halftime_away}:${m.is_home ? m.halftime_away : m.halftime_home})` : '';
      const b = beste.get(m.match_id);
      const bester = b ? ` · ${escapeHtml(b.name.split(' ').slice(-1)[0])} ${b.goals}` : '';
      return `${zeichen} ${datum(new Date(m.starts_at), now)} ${m.is_home ? 'H' : 'A'} ${escapeHtml(gegnerVon(m))} ${eigene ?? '–'}:${gegner ?? '–'}${hz}${bester}`;
    });
    return `<b>${escapeHtml(team.name)}</b> — letzte Ergebnisse\n${zeilen.join('\n')}`;
  });
  return bloecke.join('\n\n');
}

export function textTabelle(team: HandballTeamView, standings: HandballStandingsView): string {
  const breite = Math.min(22, Math.max(8, ...standings.rows.map(r => r.teamName.length)));
  const meiste = Math.max(0, ...standings.rows.map(r => r.played));
  const zeilen = standings.rows.map(r => {
    const name = r.teamName.length > breite ? `${r.teamName.slice(0, breite - 1)}…` : r.teamName.padEnd(breite);
    const marker = r.teamId === team.team_id ? '▶' : ' ';
    const nachzuholen = r.played < meiste ? '*' : ' ';
    return `${marker}${String(r.position).padStart(2)} ${name} ${String(r.played).padStart(2)}${nachzuholen}${`${r.goalsFor}:${r.goalsAgainst}`.padStart(7)} ${String(r.points).padStart(3)}`;
  });
  const spieltag = standings.rows[0]?.round;
  const teile = [
    `<b>${escapeHtml(standings.competition_name)}</b>${spieltag ? ` — nach dem ${spieltag}. Spieltag` : ''}`,
    `<pre>${escapeHtml([` #  ${'Mannschaft'.padEnd(breite)} Sp    Tore Pkt`, ...zeilen].join('\n'))}</pre>`,
  ];
  if (standings.rows.some(r => r.played < meiste)) teile.push('* weniger Spiele als die Spitze — der Spieltag ist noch nicht komplett.');
  return teile.join('\n');
}

export function textKader(team: HandballTeamView): string {
  const kader = rosterFor(team.team_id);
  if (kader.length === 0) return `<b>${escapeHtml(team.name)}</b>\nKader noch nicht geholt — der nächste Tageslauf bringt ihn.`;
  const spieler = kader.filter(r => r.role === 'player');
  const stab = kader.filter(r => r.role === 'staff');
  const zeilen = spieler.map(r => `${r.number !== null ? String(r.number).padStart(2, ' ') : ' –'}${r.numberSource === 'lineup' ? '*' : ' '} ${escapeHtml(r.name)}${r.goalkeeper ? ' (TW)' : ''}`);
  const teile = [`<b>${escapeHtml(team.name)}</b> — Kader (${spieler.length} Spieler)`, `<pre>${zeilen.join('\n')}</pre>`];
  if (stab.length > 0) teile.push(`Trainer: ${stab.map(r => escapeHtml(r.name)).join(', ')}`);
  teile.push(kaderFussnote(spieler));
  return teile.join('\n');
}

function kaderFussnote(spieler: HandballRosterName[]): string {
  const ausAufstellung = spieler.filter(r => r.numberSource === 'lineup').length;
  return ausAufstellung > 0
    ? `Nummern laut Kader — am Spieltag werden sie manchmal getauscht. ${ausAufstellung === 1 ? 'Eine Nummer (*)' : `${ausAufstellung} Nummern (*)`} fehlen im Kader und stammen aus der letzten Aufstellung.`
    : 'Nummern laut Kader — am Spieltag werden sie manchmal getauscht.';
}

/** Ein Knopf, der einen Befehl auslöst — Callback `cmd:<befehl>[:<argument>]`, unter 64 Byte. */
export function knopf(text: string, befehl: string, argument?: string): { text: string; callback_data: string } {
  return { text, callback_data: `cmd:${befehl}${argument ? `:${argument}` : ''}` };
}

export function hilfeTastatur(): InlineKeyboard {
  return { inline_keyboard: [
    [knopf('📅 Spiele', 'spiele'), knopf('📊 Tabelle', 'tabelle'), knopf('👥 Kader', 'kader')],
    [knopf('🥇 Torjäger', 'torjaeger'), knopf('📈 Saison', 'saison'), knopf('🏆 Rekorde', 'rekorde')],
    [knopf('📰 Bericht', 'bericht'), knopf('🗓 Kalender', 'kalender'), knopf('⏰ Erinnerung', 'erinnerung')],
    [knopf('🔔 Modus', 'modus')],
  ] };
}

/**
 * Unter den Torjägern ein Knopf je Spieler mit Einsatz — Nummer und
 * Nachname, drei je Zeile —, der seine Bilanz holt. Der Rückruf trägt die
 * Spieler-ID, nicht den Namen: kurz genug für Telegrams 64 Byte, und
 * eindeutig, auch wenn zwei Spieler denselben Nachnamen tragen.
 */
export function spielerTastatur(stats: HandballPlayerStats[]): InlineKeyboard | null {
  const spieler = stats.filter(p => p.games > 0).sort((a, b) => a.number - b.number);
  if (spieler.length === 0) return null;
  const knoepfe = spieler.map(p => knopf(`${p.number} ${p.name.split(' ').slice(-1)[0]}`, 'spieler', p.playerId));
  const zeilen: InlineKeyboard['inline_keyboard'] = [];
  for (let i = 0; i < knoepfe.length; i += 3) zeilen.push(knoepfe.slice(i, i + 3));
  return { inline_keyboard: zeilen };
}

/** Unter `/status`: ein Knopf je offener Rückmeldung, der sie als erledigt markiert. */
export function statusTastatur(offene: Array<{ id: number }>): InlineKeyboard | null {
  if (offene.length === 0) return null;
  return { inline_keyboard: offene.slice(0, 5).map(f => [knopf(`✓ #${f.id} erledigt`, 'erledigt', String(f.id))]) };
}

/** Was ein Chat verfolgt — die Antwort auf `/teams`. */
export function textTeams(alle: HandballTeamView[], gewaehlt: string[] | null): string {
  const eigene = gewaehlt ? alle.filter(t => gewaehlt.includes(t.team_id)) : alle;
  const namen = eigene.map(t => t.label).join(', ');
  if (alle.length > 1 && eigene.length === 0) {
    return 'Welche Mannschaften willst du verfolgen? Tipp sie unten an — gern mehrere. Bis du eine gewählt hast, schicke ich dir nichts.';
  }
  return alle.length > 1
    ? `Du verfolgst ${gewaehlt ? '' : '<b>alle</b> Mannschaften: '}<b>${escapeHtml(namen)}</b>.\nAntippen wählt eine Mannschaft an oder ab; Meldungen und Befehle gelten dann nur für die gewählten.`
    : `Es gibt nur eine Mannschaft: <b>${escapeHtml(namen)}</b>.`;
}

/** Ein Knopf je Mannschaft mit Haken, dazu „alle" — die Auswahl je Chat. */
export function teamsTastatur(alle: HandballTeamView[], gewaehlt: string[] | null): InlineKeyboard | null {
  if (alle.length < 2) return null;
  const zeilen = alle.map(t => [{ text: `${!gewaehlt || gewaehlt.includes(t.team_id) ? '✅' : '▫️'} ${t.label}`, callback_data: `cmd:teams:${t.team_id}` }]);
  if (gewaehlt) zeilen.push([{ text: 'Alle Mannschaften', callback_data: 'cmd:teams:alle' }]);
  return { inline_keyboard: zeilen };
}

export function erinnerungTastatur(): InlineKeyboard {
  return { inline_keyboard: [[
    knopf('1 Stunde', 'erinnerung', '1h'), knopf('3 Stunden', 'erinnerung', '3h'),
    knopf('Vorabend', 'erinnerung', 'abend'), knopf('Aus', 'erinnerung', 'aus'),
  ]] };
}

export function modusTastatur(): InlineKeyboard {
  return { inline_keyboard: [[knopf('Alles', 'modus', 'alles'), knopf('Nur Ergebnisse', 'modus', 'ergebnisse')]] };
}

export function endstandTastatur(m: HandballMatchView): InlineKeyboard {
  const zeilen: InlineKeyboard['inline_keyboard'] = [[knopf('📊 Tabelle', 'tabelle'), knopf('📰 Bericht', 'bericht'), knopf('🥇 Torjäger', 'torjaeger')]];
  const links = [{ text: 'Spielseite', url: m.url }, ...(m.report_url ? [{ text: 'Bogen (PDF)', url: m.report_url }] : [])];
  zeilen.push(links);
  return { inline_keyboard: zeilen };
}

export function ankuendigungTastatur(m: HandballMatchView): InlineKeyboard {
  const route = routenTastatur(m)?.inline_keyboard ?? [];
  const unten = [knopf('👥 Kader', 'kader'), knopf('📊 Tabelle', 'tabelle'), knopf('📈 Saison', 'saison')];
  return { inline_keyboard: [...route, halleAlsOrt(m) ? [halleKnopf(m), ...unten] : unten] };
}
