/**
 * Die Beschreibung des Bots bei Telegram — aus dem Stand der Mannschaften
 * gebaut und nur gesetzt, wenn sie sich ändert. Aus `handballBot.ts` gelöst
 * (ARC-3-001).
 */

import { type HandballTeamView, type HandballMatchView, aktuellesSpiel, handballOverview } from './handballSicht';
import { DATUM, gegnerVon, ZEIT } from './handballBotTexts';
import { BOT_SHORT_DESCRIPTION_MAX, BOT_DESCRIPTION_MAX, setMyDescription, setMyShortDescription } from './telegramClient';
import { wettbewerbVon, saisonName } from './handballBotImages';
import { getHandballBotToken, botRegistrationState, instanzZeile } from './handballBotBasis';
import { botAutoDescription } from '../config';
import { db } from '../db';
import { handball_bot_instance } from '../db/schema';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Beschreibung des Bots — aus dem Stand, nur bei Änderung gesetzt
// ---------------------------------------------------------------------------

/** Auf eine Höchstlänge kürzen, mit „…" statt eines abgeschnittenen Wortes. */
function kuerze(text: string, max: number): string {
  if (text.length <= max) return text;
  const schnitt = text.slice(0, max - 1);
  const leer = schnitt.lastIndexOf(' ');
  return `${(leer > max / 2 ? schnitt.slice(0, leer) : schnitt).replace(/[\s,;·—-]+$/, '')}…`;
}

function eigenerPlatz(team: HandballTeamView): { position: number; points: number; played: number } | null {
  const zeile = team.standings[0]?.rows.find(r => r.teamId === team.team_id);
  return zeile ? { position: zeile.position, points: zeile.points, played: zeile.played } : null;
}

function naechstesKurz(m: HandballMatchView): string {
  return `${DATUM.format(new Date(m.starts_at))} ${m.is_home ? 'vs' : '@'} ${gegnerVon(m)} (${m.is_home ? 'H' : 'A'})`;
}

/**
 * Die Kurzbeschreibung (Profil, Teilen; höchstens 120 Zeichen): Mannschaft,
 * Platz, nächstes Spiel — was nicht mehr passt, fällt von hinten weg.
 * Reiner Text, Telegram kennt dort kein HTML. Kein „heute"/„morgen", damit
 * sich der Text nicht jeden Tag von selbst ändert.
 */
export function textKurzbeschreibung(teams: HandballTeamView[]): string {
  const teile: string[] = [];
  for (const team of teams) {
    const platz = eigenerPlatz(team);
    const felder = [team.name, platz ? `Platz ${platz.position}` : null, team.next_match ? `Nächstes: ${naechstesKurz(team.next_match)}` : null].filter((x): x is string => !!x);
    teile.push(felder.join(' · '));
  }
  const voll = `🤾 ${teile.join(' | ') || 'Handball'}`;
  if (voll.length <= BOT_SHORT_DESCRIPTION_MAX) return voll;
  // Erst das nächste Spiel opfern, dann den Platz, dann kürzen.
  const ohneSpiel = `🤾 ${teams.map(t => [t.name, eigenerPlatz(t) ? `Platz ${eigenerPlatz(t)!.position}` : null].filter(Boolean).join(' · ')).join(' | ')}`;
  return kuerze(ohneSpiel.length <= BOT_SHORT_DESCRIPTION_MAX ? ohneSpiel : `🤾 ${teams.map(t => t.name).join(' | ')}`, BOT_SHORT_DESCRIPTION_MAX);
}

/** Die Beschreibung im leeren Chat („Was kann dieser Bot?", höchstens 512 Zeichen). */
export function textBeschreibung(teams: HandballTeamView[]): string {
  const bloecke: string[] = [];
  for (const team of teams) {
    const zeilen = [`🤾 ${team.name}`];
    const liga = [wettbewerbVon(team), saisonName(aktuellesSpiel(team.matches)?.season_id)].filter(Boolean).join(', Saison ');
    if (liga) zeilen.push(liga);
    const platz = eigenerPlatz(team);
    if (platz) zeilen.push(`Tabelle: ${platz.position}. Platz, ${platz.points} Punkte nach ${platz.played} Spiel${platz.played === 1 ? '' : 'en'}`);
    const m = team.next_match;
    if (m) zeilen.push(`Nächstes Spiel: ${DATUM.format(new Date(m.starts_at))} ${ZEIT.format(new Date(m.starts_at))} Uhr ${m.is_home ? 'gegen' : 'bei'} ${gegnerVon(m)} (${m.is_home ? 'Heimspiel' : 'auswärts'})`);
    bloecke.push(zeilen.join('\n'));
  }
  const schluss = 'Ich melde Ankündigung, Aufstellung, Halbzeit und Endstand und zeige Tabelle, Kader und Torjäger auf Nachfrage. /start zum Abonnieren.';
  const kopf = bloecke.join('\n\n') || 'Spiele, Ergebnisse und Tabelle einer Handball-Mannschaft.';
  const voll = `${kopf}\n\n${schluss}`;
  return voll.length <= BOT_DESCRIPTION_MAX ? voll : kuerze(kopf, BOT_DESCRIPTION_MAX);
}

export interface HandballBotDescriptionResult {
  status: 'aus' | 'kein_token' | 'unveraendert' | 'gesetzt';
}

/**
 * Nach jedem Abruf: Beschreibung und Kurzbeschreibung aus dem Stand setzen
 * — aber nur, was sich gegenüber dem zuletzt gesetzten Text (Instanz-Zeile)
 * geändert hat, also praktisch nach einem Spieltag oder einer Verlegung.
 * Aus, wenn der Schalter in der Dienste-Zeile aus ist (dann bleibt, was im
 * BotFather steht), ohne Token, und in einer Instanz, für die der Token
 * nicht gespeichert wurde (dieselbe Absicherung wie beim Webhook).
 */
export async function pflegeHandballBotBeschreibung(): Promise<HandballBotDescriptionResult> {
  const token = getHandballBotToken();
  if (!token || !botRegistrationState().registeredHere) return { status: 'kein_token' };
  if (!botAutoDescription()) return { status: 'aus' };
  const sicht = handballOverview();
  if (!sicht.configured || sicht.teams.length === 0) return { status: 'unveraendert' };
  const lang = textBeschreibung(sicht.teams);
  const kurz = textKurzbeschreibung(sicht.teams);
  const zeile = instanzZeile();
  let gesetzt = false;
  if (zeile?.description_text !== lang) {
    await setMyDescription(token, lang);
    db.update(handball_bot_instance).set({ description_text: lang }).where(eq(handball_bot_instance.id, 1)).run();
    gesetzt = true;
  }
  if (zeile?.short_description_text !== kurz) {
    await setMyShortDescription(token, kurz);
    db.update(handball_bot_instance).set({ short_description_text: kurz }).where(eq(handball_bot_instance.id, 1)).run();
    gesetzt = true;
  }
  return { status: gesetzt ? 'gesetzt' : 'unveraendert' };
}
