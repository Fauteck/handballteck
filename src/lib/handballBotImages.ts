/**
 * Die Bilder des Handball-Bots — je Funktion ein SVG (oder null, wenn es nichts
 * zu zeichnen gibt), für Bot, Microsite und Cockpit. Gerendert wird erst beim
 * Senden (`renderPng`); die Sender fallen auf den Text zurück, die Routen
 * antworten 404.
 */

import {
  renderStandingsSvg, renderRosterSvg, renderResultSvg, renderFixtureSvg, renderPositionChartSvg, renderScorersSvg, renderPlayerChartSvg,
  renderSeasonSummarySvg, renderGif, logoAccentColor, type ImageBrand,
} from './handballTableImage';
import { siteUrl, publicUrl } from '../config';
import {
  rosterFor, playerStats, logoDataUri, playerMatchLog, playerGames, positionHistory, tendenzReferenz, readPalette, saisonVorbei,
  type HandballMatchView, type HandballTeamView, type HandballStandingsView, type HandballPlayerStats,
} from './handballTeam';
import { DATUM, DATUM_KURZ, ZEIT, datum, gegnerId, gegnerVon } from './handballBotTexts';

/**
 * Fußzeile aller Bilder: Stand und die Adresse der Seite (ohne https://) —
 * die eigene Domain aus SITE_URL, sonst PUBLIC_URL. Bis Oktober 2026 stand
 * hier der Bot; die Bilder gehen aber auch über Seite, Push und Weiterleiten.
 */
function bildMarke(now = new Date()): ImageBrand {
  return { adresse: seitenAdresse(), stand: `${DATUM.format(now)} ${ZEIT.format(now)}` };
}

function seitenAdresse(): string | null {
  try {
    const host = new URL(siteUrl() ?? publicUrl()).hostname;
    return host && host !== 'localhost' ? host : null;
  } catch {
    return null;
  }
}

/** Der Wettbewerb einer Mannschaft — aus der Tabelle, sonst aus dem ersten Spiel. */
export function wettbewerbVon(team: HandballTeamView): string | null {
  return team.standings[0]?.competition_name ?? team.matches[0]?.competition_name ?? null;
}

// ---------------------------------------------------------------------------
// Die Bilder — je eines für Bot und Cockpit-Tab (routes/handball.ts).
// Jede Funktion liefert das SVG oder null, wenn es nichts zu zeichnen gibt;
// die Sender fallen dann auf den Text zurück, die Route antwortet 404.
// ---------------------------------------------------------------------------

/** Die Tabelle einer Staffel, mit Tendenz, nächstem Gegner und Logos. */
export function bildTabelle(team: HandballTeamView, s: HandballStandingsView): string {
  const spieltag = s.rows[0]?.round;
  return renderStandingsSvg({
    competitionName: s.competition_name,
    ownTeamId: team.team_id,
    rows: s.rows,
    subtitle: [team.championship_name, spieltag ? `nach dem ${spieltag}. Spieltag` : null].filter(Boolean).join(' · ') || null,
    logo: logoDataUri(team.team_id),
    previousRows: tendenzReferenz(s),
    nextOpponentId: team.next_match && team.next_match.status !== 'live' ? gegnerId(team.next_match) : null,
    logos: Object.fromEntries(s.rows.map(r => [r.teamId, logoDataUri(r.teamId)])),
    brand: bildMarke(),
    palette: readPalette(),
  });
}

/** Der Kader als Mannschaftsbogen — null ohne gespeicherten Kader. */
export function bildKader(team: HandballTeamView): string | null {
  const kader = rosterFor(team.team_id);
  const spieler = kader.filter(r => r.role === 'player');
  if (spieler.length === 0) return null;
  const ausAufstellung = spieler.filter(r => r.numberSource === 'lineup').length;
  return renderRosterSvg({
    teamName: team.name,
    subtitle: [team.championship_name, wettbewerbVon(team)].filter(Boolean).join(' · ') || null,
    players: spieler.map(r => ({ number: r.number, name: r.name, numberFromLineup: r.numberSource === 'lineup', goalkeeper: r.goalkeeper, captain: r.captain })),
    staff: kader.filter(r => r.role === 'staff').map(r => r.name),
    footnote: ausAufstellung > 0 ? 'Dunkles Trikot: Nummer aus der letzten Aufstellung' : null,
    logo: logoDataUri(team.team_id),
    brand: bildMarke(),
    palette: readPalette(),
  });
}

/** Das nächste Spiel als Karte, mit der Farbe des Gegners aus seinem Logo. */
export async function bildSpiel(m: HandballMatchView): Promise<string> {
  const start = new Date(m.starts_at);
  return renderFixtureSvg({
    competitionName: m.competition_name,
    subtitle: m.round ? `${m.round}. Spieltag` : null,
    homeName: m.home_name, awayName: m.away_name, ownIsHome: m.is_home,
    dateLabel: DATUM_KURZ.format(start), timeLabel: `${ZEIT.format(start)} Uhr`,
    venue: [m.venue_name, m.venue_address].filter(Boolean).join(', ') || null,
    homeLogo: logoDataUri(m.home_id), awayLogo: logoDataUri(m.away_id),
    opponentColor: await logoAccentColor(logoDataUri(gegnerId(m))),
    brand: bildMarke(),
    palette: readPalette(),
  });
}

/** Der Tabellenplatz-Verlauf — null, solange die Historie keine zwei Spieltage hat. */
export function bildVerlauf(team: HandballTeamView): string | null {
  const staffel = team.standings.find(s => positionHistory(s, team.team_id).length >= 2);
  if (!staffel) return null;
  const punkte = positionHistory(staffel, team.team_id);
  const spieltage = team.matches.filter(m => m.competition_name === staffel.competition_name && m.status !== 'cancelled').length;
  return renderPositionChartSvg({
    teamName: team.name,
    subtitle: [staffel.competition_name, 'Tabellenplatz je Spieltag'].join(' · '),
    logo: logoDataUri(team.team_id),
    points: punkte,
    totalRounds: spieltage > 0 ? spieltage : null,
    nextOpponent: team.next_match ? { name: gegnerVon(team.next_match), logo: logoDataUri(gegnerId(team.next_match)) } : null,
    brand: bildMarke(),
    palette: readPalette(),
  });
}

/** Die Torjäger als Balken — null ohne ein gespeichertes Tor. */
export function bildTorjaeger(team: HandballTeamView, stats: HandballPlayerStats[] = playerStats(team.team_id)): string | null {
  const mitTor = stats.filter(p => p.goals > 0);
  if (mitTor.length === 0) return null;
  const tore = stats.reduce((a, p) => a + p.goals, 0);
  const spiele = new Set(playerGames(team.team_id).map(g => g.matchId)).size;
  return renderScorersSvg({
    teamName: team.name,
    subtitle: [team.championship_name, `Torjäger der Saison · ${tore} Tore in ${spiele} Spiel${spiele === 1 ? '' : 'en'}`].filter(Boolean).join(' · '),
    logo: logoDataUri(team.team_id),
    scorers: mitTor.map(p => ({ name: p.name, number: p.number, goals: p.goals, sevenMeterGoals: p.sevenMeterGoals, games: p.games })),
    totalGoals: tore,
    brand: bildMarke(),
    palette: readPalette(),
  });
}

/** Die Tore je Spiel eines Spielers — null unter zwei Spielen. */
export function bildSpieler(team: HandballTeamView, p: HandballPlayerStats, now = new Date()): string | null {
  const verlauf = playerMatchLog(team.team_id, p.playerId);
  if (verlauf.length < 2) return null;
  return renderPlayerChartSvg({
    name: p.name,
    number: p.number,
    teamName: team.name,
    subtitle: [team.name, 'Tore je Spiel'].join(' · '),
    logo: logoDataUri(team.team_id),
    games: verlauf.map(v => ({ opponent: v.opponent, dateLabel: v.startsAt ? datum(new Date(v.startsAt), now) : '', goals: v.goals, isHome: v.isHome, logo: v.opponentId ? logoDataUri(v.opponentId) : null })),
    brand: bildMarke(),
    palette: readPalette(),
  });
}

/** „2026/27" aus der Saison-ID der Quelle („2627") — sonst null. */
export function saisonName(seasonId: number | undefined): string | null {
  const s = String(seasonId ?? '');
  return /^\d{4}$/.test(s) ? `20${s.slice(0, 2)}/${s.slice(2)}` : null;
}

/**
 * Die Saisonabschluss-Karte: Endplatz, Bilanz, Tore, Torschützenkönig,
 * höchster Sieg, Verlauf klein. Null, solange kein Spiel gewertet ist —
 * `/saisonkarte` zeigt sie auch mitten in der Saison, dann ausdrücklich als
 * **Zwischenbilanz** (ohne „Endplatz" und ohne Meister-Pille): Nach drei
 * Spieltagen auf Platz 1 stand bis zum 27.09.2026 „Meister" auf der Karte.
 */
export function bildSaison(team: HandballTeamView, now = new Date()): string | null {
  const gespielt = team.matches.filter(m => (m.status === 'finished' || m.rated) && m.score_home !== null && m.score_away !== null);
  if (gespielt.length === 0) return null;
  const eigene = (m: HandballMatchView) => (m.is_home ? m.score_home! : m.score_away!);
  const andere = (m: HandballMatchView) => (m.is_home ? m.score_away! : m.score_home!);
  const s = gespielt.filter(m => m.won === true).length;
  const n = gespielt.filter(m => m.won === false).length;
  const u = gespielt.length - s - n;
  const staffel = team.standings[0];
  const zeile = staffel?.rows.find(r => r.teamId === team.team_id);
  const bester = [...gespielt].sort((a, b) => (eigene(b) - andere(b)) - (eigene(a) - andere(a)))[0];
  const koenig = playerStats(team.team_id).find(p => p.goals > 0);
  return renderSeasonSummarySvg({
    teamName: team.name,
    competitionName: staffel?.competition_name ?? wettbewerbVon(team) ?? '',
    subtitle: [team.championship_name, saisonName(team.matches[0]?.season_id) ? `Saison ${saisonName(team.matches[0]?.season_id)}` : null].filter(Boolean).join(' · ') || null,
    position: zeile?.position ?? null,
    teams: staffel ? staffel.rows.length : null,
    won: s, drawn: u, lost: n,
    goalsFor: gespielt.reduce((a, m) => a + eigene(m), 0),
    goalsAgainst: gespielt.reduce((a, m) => a + andere(m), 0),
    points: zeile?.points ?? s * 2 + u,
    topScorer: koenig ? `${koenig.name} · ${koenig.goals} Tor${koenig.goals === 1 ? '' : 'e'}` : null,
    biggestWin: bester && eigene(bester) > andere(bester) ? `${eigene(bester)}:${andere(bester)} ${bester.is_home ? 'gegen' : 'bei'} ${gegnerVon(bester)}` : null,
    positions: staffel ? positionHistory(staffel, team.team_id).map(p => ({ round: p.round, position: p.position })) : null,
    logo: logoDataUri(team.team_id),
    brand: bildMarke(),
    palette: readPalette(),
    zwischenstand: !saisonVorbei(team, now).vorbei,
  });
}

/**
 * Der Endstand als Karte (seit 27.09.2026): die Logos beider Vereine, der
 * Stand groß, Halbzeit, Sieg/Niederlage als Pille — im Vereins-CD. Keine
 * Torschützen im Bild, die stehen im Text darunter: Der bisherige Text wird
 * zur Bildunterschrift; ist er zu lang
 * für eine (1024 Zeichen), geht er als zweite Nachricht hinterher. Ohne
 * Bild-Weg oder bei einem Fehlschlag kommt der Text allein.
 */
export interface EndstandKarteExtras {
  /** „Eskil Lieck · 12 Tore" */
  playerOfMatch?: string | null;
}

/** Wie viele Siege in Folge, das genannte Spiel eingeschlossen — null unter zwei. */
function siegesserie(team: HandballTeamView, m: HandballMatchView): string | null {
  const gespielt = team.matches.filter(x => x.status === 'finished' && x.score_home !== null && x.score_away !== null);
  const bis = gespielt.findIndex(x => x.match_id === m.match_id);
  if (bis < 0 || gespielt[bis].won !== true) return null;
  let n = 0;
  for (let i = bis; i >= 0 && gespielt[i].won === true; i--) n++;
  return n >= 2 ? `${n}. Sieg in Folge` : null;
}

/** „Platz 1 · 6:0 Punkte" aus der gespeicherten Tabelle. */
function tabellenStand(team: HandballTeamView): string | null {
  const zeile = team.standings.flatMap(s => s.rows).find(r => r.teamId === team.team_id);
  return zeile ? `Platz ${zeile.position} · ${zeile.points}:${zeile.played * 2 - zeile.points} Punkte` : null;
}

function endstandEingabe(team: HandballTeamView, m: HandballMatchView, extras: EndstandKarteExtras, opponentColor: string | null) {
  const start = new Date(m.starts_at);
  return {
    competitionName: m.competition_name,
    subtitle: m.round ? `${m.round}. Spieltag` : null,
    dateLabel: `${DATUM_KURZ.format(start)} · ${ZEIT.format(start)}`,
    homeName: m.home_name,
    awayName: m.away_name,
    scoreHome: m.score_home ?? 0,
    scoreAway: m.score_away ?? 0,
    halftime: m.halftime_home !== null && m.halftime_away !== null ? { home: m.halftime_home, away: m.halftime_away } : null,
    ownIsHome: m.is_home,
    outcome: (m.won === true ? 'win' : m.won === false ? 'loss' : 'draw') as 'win' | 'loss' | 'draw',
    venue: m.venue_name,
    homeLogo: logoDataUri(m.home_id),
    awayLogo: logoDataUri(m.away_id),
    opponentColor,
    playerOfMatch: extras.playerOfMatch ?? null,
    streak: siegesserie(team, m),
    standing: tabellenStand(team),
    brand: bildMarke(),
    palette: readPalette(),
  };
}

/** Die Endstand-Karte als SVG — fertig, ohne Animation. */
export async function endstandBild(team: HandballTeamView, m: HandballMatchView, extras: EndstandKarteExtras = {}): Promise<string> {
  return renderResultSvg(endstandEingabe(team, m, extras, await logoAccentColor(logoDataUri(gegnerId(m)))));
}

/** Bilder je Animationsschritt der Endstand-Karte; das GIF baut `renderGif` daraus. */
const ENDSTAND_FRAMES = 12;
const ENDSTAND_FRAME_MS = 90;
const ENDSTAND_HOLD_MS = 3500;

/**
 * Die Endstand-Karte als Animation: die Zahlen zählen hoch (schnell am
 * Anfang, langsam am Ende), Halbzeit, Ausgang und Glanz erscheinen mit dem
 * letzten Bild, das dann stehen bleibt. Ein Sieg, den man beim Aufzählen
 * kommen sieht, ist ein anderes Gefühl als eine Zahl.
 */
export async function endstandAnimation(team: HandballTeamView, m: HandballMatchView, extras: EndstandKarteExtras = {}): Promise<Buffer> {
  const eingabe = endstandEingabe(team, m, extras, await logoAccentColor(logoDataUri(gegnerId(m))));
  const frames: string[] = [];
  for (let i = 0; i <= ENDSTAND_FRAMES; i++) {
    const t = i / ENDSTAND_FRAMES;
    const ease = 1 - Math.pow(1 - t, 3);
    frames.push(renderResultSvg({
      ...eingabe,
      frame: { scoreHome: Math.round(eingabe.scoreHome * ease), scoreAway: Math.round(eingabe.scoreAway * ease), final: i === ENDSTAND_FRAMES },
    }));
  }
  return renderGif(frames, { delayMs: ENDSTAND_FRAME_MS, holdLastMs: ENDSTAND_HOLD_MS });
}
