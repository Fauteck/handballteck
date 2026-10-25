/**
 * Handball-Telegram-Bot (Wiki „Handball-Verfolgung (handball.net)“ §5).
 *
 * Ein eigener Bot neben dem Todoteck-Bot, und zwar aus einem Grund, der
 * im Konzept des ersten steht (docs/telegram-bot-strategy.md §3.1): Der
 * Todoteck-Bot bindet jeden Chat an ein Todoteck-Konto, weil er in dessen
 * Namen Aufgaben anlegt und Quittungen bucht. Wer die Spiele einer
 * Jugendmannschaft mitbekommen will, hat kein Konto und soll keins brauchen.
 * Dieser Bot schreibt nichts in Todoteck; er kennt nur Chats, die ihn
 * abonniert haben, und redet über öffentliche Daten von handball.net.
 *
 * **Aufgeteilt** (Oktober 2026): Dieses Modul ist der Kern — Konfiguration,
 * Abonnenten, Befehle, Sender, Inline-Modus und die Runden von sich aus. Die
 * reinen Texte und Tastaturen stehen in `handballBotTexts.ts`, die SVG-Bilder
 * in `handballBotImages.ts`; beide werden hier wieder ausgeführt, damit
 * `import … from './handballBot'` überall weiter gilt.
 *
 * Was er von sich aus schickt (je Spiel je einmal, Merker in
 * `handball_bot_sent`):
 * - **Ankündigung** eine Stunde vor dem Anwurf — Gegner, Halle, Anschrift.
 * - **Aufstellung** zum Anwurf — mit Namen, Torwart, Kapitän. Die
 *   Aufstellung selbst maskiert bei Jugendspielen die Namen; sie kommen aus
 *   dem Kader, zugeordnet über die Spieler-ID (nie über die Nummer, siehe
 *   `fetchRoster`). Die Liste erscheint rund zwei Minuten vor dem Anwurf,
 *   deshalb wird ab fünf Minuten davor bis eine halbe Stunde danach je Takt
 *   einmal nachgesehen.
 * - **Endstand** nach dem Abpfiff — mit Torschützen und dem Link zur
 *   Spielseite.
 * - Seit dem 27.09.2026 dazu: **Halbzeitstand** (aus der Torfolge, ein Blick
 *   ab Anwurf plus 27 Minuten), **Spielbericht** (der Text der Quelle, sobald
 *   er da ist, samt Spielberichtsbogen als PDF), **Verlegungen und Absagen**
 *   (was der Abruf an einem gespeicherten Spiel geändert vorfindet), ein
 *   **Routen-Knopf** unter der Ankündigung und darin ein **Gegner-Steckbrief**
 *   (Tabellenplatz, letzte drei Ergebnisse, Hinspiel).
 *
 * Was man ihn fragen kann: /spiele, /ergebnisse, /tabelle, /kader, /spieler,
 * /saison, /bericht, /live, /kalender, /erinnerung, /modus, /feedback, /hilfe,
 * /stop — und der Betreiber /status und /rundruf. In Gruppen dasselbe mit
 * `@botname`; dort abonniert `/start` die Gruppe, und Freitext bleibt
 * unbeantwortet. Unter den Meldungen liegen Inline-Knöpfe, die dieselben
 * Befehle auslösen (`cmd:<befehl>[:<argument>]` als Callback).
 *
 * Seit dem 27.09.2026 (dritte Runde): Vorlauf der Ankündigung je Chat
 * (`/erinnerung`), Modus „nur Ergebnisse" (`/modus`), Saisonbilanz,
 * Tabellenbewegung und Spieler des Spiels im Endstand, Direktvergleich im
 * Steckbrief, Spielplan als Kalenderdatei, `/live` als Zwischenstand auf
 * Nachfrage, das nächste Spiel als Karte, Tendenzpfeile in der Tabelle, eine
 * 🏆-Reaktion auf den Sieg, Rundruf und Feedback.
 *
 * Sechste Runde (27.09.2026, Telegram-Funktionen): Admin-Befehle nur im Menü
 * der Admin-Chats, „schickt ein Foto …" während ein Bild entsteht, die Halle
 * als Ort unter der Ankündigung und hinter „📍 Halle", der Inline-Modus
 * (`@bot tab` in jedem Chat, Bilder über signierte Links), Konfetti zum Sieg
 * im Privatchat und Beschreibung/Kurzbeschreibung aus dem Stand.
 *
 * Token wie beim ersten Bot als ENV (`HANDBALL_BOT_TOKEN`), aus denselben
 * Gründen (docs/telegram-bot-strategy.md §9): ein Instanz-Geheimnis, kein
 * Nutzer-Geheimnis, und ein Backup-Restore in eine andere Umgebung darf den
 * Webhook nicht verbiegen. Optional `HANDBALL_BOT_INVITE_CODE`: Ist er
 * gesetzt, abonniert nur, wer `/start <code>` schickt (oder den Deep-Link
 * `t.me/<bot>?start=<code>` öffnet) — der Bot ist sonst für jeden offen, der
 * seinen Namen kennt.
 */

import crypto from 'node:crypto';
import { and, eq, gte, lt } from 'drizzle-orm';
import { db } from '../db';
import { handball_bot_sent, handball_bot_feedback, handball_bot_delivery, handball_site_subscription } from '../db/schema';
import {
  sendMessage, sendPhotoBytes, sendAnimationBytes, sendFileIdAgain, sendDocument, setMessageReaction, answerCallbackQuery, getMe,
  escapeHtml, TelegramApiError, sendChatAction, sendVenue, answerInlineQuery, sendMediaGroupPhotos, type TelegramUpdate,
  type TelegramInlineQuery, type InlineKeyboard, type ChatAction, type InlineQueryResultPhoto, type AnswerInlineQueryOptions,
  type TelegramMessage,
} from './telegramClient';
import { svgAlsPng } from './bildCache';
import { fetchMatchEvents, sourceTimeToUtc } from './handballNetClient';
import { rosterFor, playerStats, ensureMatchReport, backlogFor, getHandballHealth, playerGames, merkeAnwurfSchaetzung, zeitzonenStand, saisonVorbei } from './handballTeam';
import { type HandballMatchView, type HandballTeamView, type HandballStandingsView } from './handballSicht';
import { handballOverview } from './handballSicht';
import { serviceLog } from './serviceLogger';
import {
  DATUM, ZEIT, berichtTastatur, botIdentity, datum, erinnerungTastatur, gegnerVon, halleAlsOrt, hilfeTastatur, icsKalender, knopf,
  modusTastatur, routenTastatur, spielTastatur, spielerTastatur, spielerTreffer, statusTastatur, teamsTastatur, textBericht,
  textErgebnisse, textKader, textLive, textRekorde, textSaison, textSpiele, textSpieler, textTabelle, textTeams,
} from './handballBotTexts';
import {
  bildKader, bildSaison, bildSpiel, bildSpieler, bildTabelle, bildTorjaeger, bildVerlauf, endstandBild, wettbewerbVon,
} from './handballBotImages';
import { listSubscribers, offeneRueckmeldungen, zustellBilanz, inlineAn, botRegistrationState, webhookZustand, handballWebhookBefund, getHandballBotToken, inviteCode, subscribe, setTeams, istAbonnent, touch, unsubscribe, abonnent, DEFAULT_LEAD, LEADS, type Lead, setLead, setMode, adminChatIds, istAdmin, refreshHandballWebhookInfo, meineTeams, LIVE_WINDOW_MS, ensureHandballBotSecrets, publicUrl, type HandballSubscriber, verfolgt, type Zustellung, type Mode, setzeInlineAn, __resetHandballBotBasisForTests } from './handballBotBasis';
export * from './handballBotTexts';
export * from './handballBotImages';

/**
 * Die Tabelle als Bild — am Telefon bleibt sie so eine Tabelle, als
 * Festbreitentext bricht Telegram sie um. Schlägt Rendern oder Senden fehl,
 * kommt die Textfassung; ein Befehl ohne Antwort wäre der schlechtere Fall.
 */

async function tabelleSenden(chatId: string, team: HandballTeamView, s: HandballStandingsView, deps: HandballBotDeps): Promise<void> {
  if (deps.sendPhoto) {
    zeigeAktivitaet(chatId, 'upload_photo', deps);
    try {
      const png = await svgAlsPng(bildTabelle(team, s));
      const caption = tabellenUnterschrift(s);
      await deps.sendPhoto(chatId, png, caption, 'tabelle.png');
      return;
    } catch (err) {
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Tabelle als Bild fehlgeschlagen — Textfassung');
    }
  }
  await deps.send(chatId, textTabelle(team, s));
}

/**
 * Der Kader als Bild — derselbe Weg wie die Tabelle, mit `textKader` als
 * Rückfall. Ohne Kader in der Datenbank gibt es nichts zu zeichnen; dann
 * sagt die Textfassung, dass der nächste Tageslauf ihn bringt.
 */
async function kaderSenden(chatId: string, team: HandballTeamView, deps: HandballBotDeps): Promise<void> {
  const svg = deps.sendPhoto ? bildKader(team) : null;
  if (svg && deps.sendPhoto) {
    zeigeAktivitaet(chatId, 'upload_photo', deps);
    try {
      const png = await svgAlsPng(svg);
      const spieler = rosterFor(team.team_id).filter(r => r.role === 'player').length;
      const caption = `<b>${escapeHtml(team.name)}</b> — Kader (${spieler} Spieler)`;
      await deps.sendPhoto(chatId, png, caption, 'kader.png');
      return;
    } catch (err) {
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Kader als Bild fehlgeschlagen — Textfassung');
    }
  }
  await deps.send(chatId, textKader(team));
}


/**
 * Ein Bild mit dem Text als Unterschrift — passt er nicht in eine (1024
 * Zeichen), folgt er als Nachricht. Scheitert das Bild, kommt der Text allein.
 */
async function bildMitText(chatId: string, svg: () => string, text: string, filename: string, deps: HandballBotDeps, keyboard: InlineKeyboard | null = null): Promise<void> {
  if (deps.sendPhoto) {
    zeigeAktivitaet(chatId, 'upload_photo', deps);
    try {
      const png = await svgAlsPng(svg());
      const passt = text.length <= CAPTION_MAX_CHARS;
      await deps.sendPhoto(chatId, png, passt ? text : text.split('\n')[0], filename, keyboard);
      if (!passt) await deps.send(chatId, text);
      return;
    } catch (err) {
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err), filename }, '[handball-bot] Bild fehlgeschlagen — Textfassung');
    }
  }
  await deps.send(chatId, text, keyboard);
}

/**
 * `/saison`: die Bilanz als Text, und sobald der Verlauf zwei Spieltage hat,
 * als Unterschrift unter dem Tabellenplatz-Verlauf (`renderPositionChartSvg`).
 * Die Achse reicht bis zum letzten angesetzten Spieltag der Staffel.
 */
async function saisonSenden(chatId: string, team: HandballTeamView, deps: HandballBotDeps): Promise<void> {
  const text = textSaison(team);
  const svg = bildVerlauf(team);
  const tastatur = saisonTastatur(team);
  if (!svg) { await deps.send(chatId, text, tastatur); return; }
  await bildMitText(chatId, () => svg, text, 'verlauf.png', deps, tastatur);
}

/**
 * Unter `/saison`: der Knopf zur Karte — nur, wenn es etwas zu zeichnen gibt.
 * Mitten in der Saison heißt er „Zwischenbilanz", danach „Saisonkarte".
 */
export function saisonTastatur(team: HandballTeamView, now = new Date()): InlineKeyboard | null {
  if (!team.matches.some(m => (m.status === 'finished' || m.rated) && m.score_home !== null)) return null;
  const titel = saisonVorbei(team, now).vorbei ? '🏅 Saisonkarte' : '📊 Zwischenbilanz';
  return { inline_keyboard: [[knopf(titel, 'saisonkarte')]] };
}

/** `/saisonkarte`: die Karte mit der Bilanz als Unterschrift; ohne Spiel die Textfassung. */
async function saisonkarteSenden(chatId: string, team: HandballTeamView, deps: HandballBotDeps): Promise<void> {
  const text = textSaison(team);
  const svg = bildSaison(team);
  if (!svg) { await deps.send(chatId, text); return; }
  await bildMitText(chatId, () => svg, text, 'saison.png', deps);
}

/** `/torjaeger`: die Torschützen als Balken, die Liste als Unterschrift; ohne Tor die Textfassung. */
async function torjaegerSenden(chatId: string, team: HandballTeamView, deps: HandballBotDeps): Promise<void> {
  const stats = playerStats(team.team_id);
  const text = textSpieler(team, stats, '');
  const tastatur = spielerTastatur(stats);
  const svg = bildTorjaeger(team, stats);
  if (!svg) { await deps.send(chatId, text, tastatur); return; }
  await bildMitText(chatId, () => svg, text, 'torjaeger.png', deps, tastatur);
}

/**
 * `/spieler Name`: trifft der Name genau einen Spieler mit mindestens zwei
 * Spielen, kommt seine Bilanz als Unterschrift unter den Toren je Spiel
 * (`renderPlayerChartSvg`); sonst, und ohne Namen, der Text.
 */
async function spielerSenden(chatId: string, team: HandballTeamView, suche: string, deps: HandballBotDeps, now = new Date()): Promise<void> {
  const stats = playerStats(team.team_id);
  const text = textSpieler(team, stats, suche);
  const treffer = spielerTreffer(stats, suche);
  const svg = treffer.length === 1 ? bildSpieler(team, treffer[0], now) : null;
  if (!svg) { await deps.send(chatId, text); return; }
  await bildMitText(chatId, () => svg, text, 'spieler.png', deps);
}

/** Telegrams Obergrenze für eine Bildunterschrift, mit Luft für Entities. */
const CAPTION_MAX_CHARS = 1000;

/**
 * `/halle` und der Knopf „📍 Halle": die Halle als Ort. Mit Spiel-ID die
 * dieses Spiels, sonst die des nächsten. Ohne Koordinaten (oder ohne
 * Ort-Weg) die Anschrift als Text mit dem Routen-Knopf.
 */
async function halleSenden(chatId: string, teams: HandballTeamView[], deps: HandballBotDeps, matchId = ''): Promise<void> {
  const alle = teams.flatMap(t => t.matches);
  const m = (matchId ? alle.find(x => x.match_id === matchId) : undefined)
    ?? teams.map(t => t.next_match).find((x): x is HandballMatchView => !!x) ?? null;
  if (!m) { await deps.send(chatId, 'Es ist gerade kein Spiel angesetzt.'); return; }
  const ort = halleAlsOrt(m);
  if (ort && deps.sendVenue) {
    zeigeAktivitaet(chatId, 'find_location', deps);
    try {
      await deps.sendVenue(chatId, ort);
      return;
    } catch (err) {
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Halle als Ort nicht zustellbar — Textfassung');
    }
  }
  const halle = [m.venue_name, m.venue_address].filter(Boolean).join(', ');
  await deps.send(chatId, halle
    ? `📍 ${escapeHtml(halle)}\n${m.is_home ? 'Heimspiel gegen' : 'Auswärts bei'} ${escapeHtml(gegnerVon(m))}, ${DATUM.format(new Date(m.starts_at))} ${ZEIT.format(new Date(m.starts_at))} Uhr`
    : 'Zu diesem Spiel nennt handball.net keine Halle.', routenTastatur(m));
}

export function halbzeitTastatur(): InlineKeyboard {
  return { inline_keyboard: [[knopf('⏱ Zwischenstand', 'live')]] };
}

/**
 * Ein Bild eines Albums, noch ungerendert: das SVG, die Unterschrift und,
 * falls das Einzelbild Knöpfe trug, diese samt kurzem Text — ein Album kann
 * keine Knöpfe tragen, sie kommen dann als Folgenachricht.
 */
interface AlbumTeil {
  svg: string;
  caption: string;
  filename: string;
  knoepfe?: { text: string; keyboard: InlineKeyboard } | null;
}

/**
 * Mehrere Bilder an **einen** Chat als Album statt als einzelne Nachrichten
 * (seit 27.09.2026): zwei Tabellen, zwei Mannschaften, Verlauf und
 * Saisonkarte. Gibt `false` zurück, wenn es kein Album wird — unter zwei
 * Bildern, ohne Album-Weg, oder wenn das Rendern scheitert —, dann schickt
 * der Aufrufer wie bisher einzeln. Gerendert wird erst, wenn feststeht,
 * dass es ein Album wird: Der häufige Fall ist ein Bild, und das soll nicht
 * zweimal entstehen.
 *
 * Die Unterschriften stehen gesammelt am ersten Foto; passen sie nicht in
 * eine, steht dort die erste Zeile und der Text folgt. Lehnt Telegram das
 * Album ab (400, Format), gehen die schon gerenderten Bilder einzeln — ein
 * 403 bleibt ein 403.
 */
async function alsAlbum(chatId: string, teile: AlbumTeil[], deps: HandballBotDeps): Promise<boolean> {
  if (teile.length < 2 || !deps.sendMediaGroup || !deps.sendPhoto) return false;
  zeigeAktivitaet(chatId, 'upload_photo', deps);
  let pngs: Buffer[];
  try {
    pngs = await Promise.all(teile.map(t => svgAlsPng(t.svg)));
  } catch (err) {
    serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Album nicht gerendert — einzeln');
    return false;
  }
  const sendPhoto = deps.sendPhoto;
  const unterschriften = teile.map(t => t.caption).filter(Boolean);
  const gesamt = unterschriften.join('\n\n');
  const passt = gesamt.length <= CAPTION_MAX_CHARS;
  const einzeln = async () => {
    for (const [i, t] of teile.entries()) {
      const kurz = t.caption.length <= CAPTION_MAX_CHARS;
      await sendPhoto(chatId, pngs[i], kurz ? t.caption : t.caption.split('\n')[0], t.filename, t.knoepfe?.keyboard ?? null);
      if (!kurz) await deps.send(chatId, t.caption);
    }
  };
  // Je zehn ein Album (Telegrams Grenze); ein einzelner Rest geht als Foto.
  for (let start = 0; start < teile.length; start += 10) {
    const stueck = teile.slice(start, start + 10);
    const erstes = start === 0;
    try {
      if (stueck.length === 1) {
        await sendPhoto(chatId, pngs[start], stueck[0].caption.split('\n')[0], stueck[0].filename);
      } else {
        await deps.sendMediaGroup(chatId, stueck.map((t, i) => ({
          png: pngs[start + i], filename: t.filename,
          caption: erstes && i === 0 ? (passt ? gesamt : (unterschriften[0] ?? '').split('\n')[0]) || undefined : undefined,
        })));
      }
    } catch (err) {
      if (err instanceof TelegramApiError && (err.status === 403 || (err.status === 400 && CHAT_WEG.test(err.message)))) throw err;
      if (!erstes) throw err;
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Album abgelehnt — Einzelbilder');
      await einzeln();
      return true;
    }
  }
  if (!passt && gesamt) await deps.send(chatId, gesamt);
  for (const t of teile) if (t.knoepfe) await deps.send(chatId, t.knoepfe.text, t.knoepfe.keyboard);
  return true;
}

function tabellenUnterschrift(s: HandballStandingsView): string {
  const spieltag = s.rows[0]?.round;
  return `<b>${escapeHtml(s.competition_name)}</b>${spieltag ? ` — nach dem ${spieltag}. Spieltag` : ''}`;
}

/** `/tabelle`: je Staffel ein Bild — ab zwei als Album. */
async function tabellenSenden(chatId: string, teams: HandballTeamView[], deps: HandballBotDeps): Promise<void> {
  const paare = teams.flatMap(team => team.standings.map(s => ({ team, s })));
  if (paare.length === 0) { await deps.send(chatId, 'Noch keine Tabelle geholt — der nächste Lauf bringt sie.'); return; }
  const teile = paare.map(({ team, s }) => ({ svg: bildTabelle(team, s), caption: tabellenUnterschrift(s), filename: 'tabelle.png' }));
  if (await alsAlbum(chatId, teile, deps)) return;
  for (const { team, s } of paare) await tabelleSenden(chatId, team, s, deps);
}

/** `/kader`: je Mannschaft ein Bild — ab zwei als Album; ohne Kader der Text. */
async function kaderAlleSenden(chatId: string, teams: HandballTeamView[], deps: HandballBotDeps): Promise<void> {
  const teile = teams.flatMap(team => {
    const svg = bildKader(team);
    const spieler = rosterFor(team.team_id).filter(r => r.role === 'player').length;
    return svg ? [{ svg, caption: `<b>${escapeHtml(team.name)}</b> — Kader (${spieler} Spieler)`, filename: 'kader.png' }] : [];
  });
  if (teile.length === teams.length && await alsAlbum(chatId, teile, deps)) return;
  for (const team of teams) await kaderSenden(chatId, team, deps);
}

/** `/torjaeger` (und `/spieler` ohne Namen): ab zwei Mannschaften mit Toren ein Album, die Spieler-Knöpfe folgen. */
async function torjaegerAlleSenden(chatId: string, teams: HandballTeamView[], deps: HandballBotDeps): Promise<void> {
  const teile = teams.flatMap(team => {
    const stats = playerStats(team.team_id);
    const svg = bildTorjaeger(team, stats);
    const tastatur = spielerTastatur(stats);
    return svg ? [{
      svg, caption: textSpieler(team, stats, ''), filename: 'torjaeger.png',
      knoepfe: tastatur ? { text: `🥇 <b>${escapeHtml(team.name)}</b> — Spieler antippen für die Bilanz:`, keyboard: tastatur } : null,
    }] : [];
  });
  if (teile.length === teams.length && await alsAlbum(chatId, teile, deps)) return;
  for (const team of teams) await torjaegerSenden(chatId, team, deps);
}

/**
 * `/saison`: je Mannschaft der Verlauf mit der Bilanz als Unterschrift und
 * dem Knopf zur Karte. **Kein Album und keine Karte von selbst** (seit dem
 * 27.09.2026 abends): Die erste Fassung legte Verlauf und Saisonkarte immer
 * zusammen in ein Album — mitten in der Saison stand dann eine Abschlusskarte
 * mit „Meister" da, und weil beide Bilder verschiedene Seitenverhältnisse
 * haben, schnitt Telegram die Karte im Album links und rechts ab. Nach dem
 * letzten Spieltag kommt die fertige Saisonkarte als eigenes Foto dazu.
 */
async function saisonAlleSenden(chatId: string, teams: HandballTeamView[], deps: HandballBotDeps, now = new Date()): Promise<void> {
  for (const team of teams) {
    await saisonSenden(chatId, team, deps);
    if (saisonVorbei(team, now).vorbei) await saisonkarteSenden(chatId, team, deps);
  }
}

/** `/saisonkarte`: ab zwei Mannschaften ein Album. */
async function saisonkartenSenden(chatId: string, teams: HandballTeamView[], deps: HandballBotDeps): Promise<void> {
  const teile = teams.flatMap(team => {
    const svg = bildSaison(team);
    return svg ? [{ svg, caption: textSaison(team), filename: 'saison.png' }] : [];
  });
  if (teile.length === teams.length && await alsAlbum(chatId, teile, deps)) return;
  for (const team of teams) await saisonkarteSenden(chatId, team, deps);
}

/** Das nächste Spiel als Karte, die Liste der nächsten fünf als Unterschrift; ohne Bild-Weg der Text. */
async function spieleSenden(chatId: string, teams: HandballTeamView[], deps: HandballBotDeps, now = new Date()): Promise<void> {
  const text = textSpiele(teams, now);
  const team = teams.find(t => t.next_match);
  const m = team?.next_match ?? null;
  if (deps.sendPhoto && team && m && !m.is_live) {
    zeigeAktivitaet(chatId, 'upload_photo', deps);
    try {
      const png = await svgAlsPng(await bildSpiel(m));
      await deps.sendPhoto(chatId, png, text.length <= CAPTION_MAX_CHARS ? text : text.split('\n\n')[0], 'spiel.png', spielTastatur(m));
      return;
    } catch (err) {
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Spiel-Karte fehlgeschlagen — Textfassung');
    }
  }
  await deps.send(chatId, text);
}

function textHilfe(teams: HandballTeamView[]): string {
  const namen = teams.map(t => t.name).join(', ') || 'die eingetragene Mannschaft';
  return [
    `Ich melde die Spiele von <b>${escapeHtml(namen)}</b>: vor dem Anwurf (mit Route und Gegner-Steckbrief), die Aufstellung zum Anwurf, den Halbzeitstand, den Endstand mit Torschützen, den Spielbericht — und wenn ein Spiel verlegt oder abgesetzt wird.${teams.length > 1 ? ' Mit /teams wählst du, welche Mannschaften du verfolgst.' : ''}`,
    '',
    '/spiele — die nächsten Spiele',
    '/ergebnisse — die letzten Ergebnisse',
    '/tabelle — die aktuelle Tabelle',
    '/kader — der Kader mit Rückennummern',
    '/torjaeger — die Torjäger als Grafik, mit einem Knopf je Spieler',
    '/spieler — die Bilanz eines Spielers als Grafik (Knopf oder /spieler Name)',
    '/saison — die Saisonbilanz mit Tabellenplatz-Verlauf',
    '/saisonkarte — die Saisonbilanz als Karte zum Weiterleiten',
    '/rekorde — die Rekorde der Saison',
    '/bericht — der Spielbericht zum letzten Spiel',
    '/live — Zwischenstand, wenn ein Spiel läuft',
    '/kalender — alle Spiele als Kalenderdatei',
    '/halle — die Halle des nächsten Spiels als Ort',
    ...(teams.length > 1 ? ['/teams — welche Mannschaften du verfolgst'] : []),
    '/erinnerung — wann vor dem Anwurf erinnern (1h, 3h, abend, aus)',
    '/modus — alles oder nur Ergebnisse',
    '/feedback — ein Wort an den Betreiber',
    '/stop — keine Meldungen mehr',
  ].join('\n');
}

/** `/status` für den Betreiber — der Betriebsstand ohne Blick in die Dienste-Seite. */
export function textStatus(sicht: ReturnType<typeof handballOverview>, now = new Date()): string {
  const abos = listSubscribers();
  const gruppen = abos.filter(a => a.chatId.startsWith('-')).length;
  const nurErgebnisse = abos.filter(a => a.mode === 'results').length;
  const nachzuholen = sicht.teams.map(t => backlogFor(t.team_id)).reduce((a, b) => ({ lineupsMissing: a.lineupsMissing + b.lineupsMissing, logosMissing: a.logosMissing + b.logosMissing }), { lineupsMissing: 0, logosMissing: 0 });
  const feedback = db.select().from(handball_bot_feedback).all();
  const offene = offeneRueckmeldungen();
  const stand = sicht.updated_at ? `${DATUM.format(new Date(sicht.updated_at))} ${ZEIT.format(new Date(sicht.updated_at))}` : 'noch nie';
  const fehler = getHandballHealth().lastError;
  const tz = zeitzonenStand();
  const bilanz = zustellBilanz(now);
  const namen = new Map(abos.map(a => [a.chatId, a.name]));
  const zeilen = [
    `🛠 <b>Betriebsstand</b>${botIdentity.username ? ` @${escapeHtml(botIdentity.username)}` : ''}`,
    `Abonnenten: ${abos.length}${gruppen ? ` (davon ${gruppen} Gruppe${gruppen === 1 ? '' : 'n'})` : ''}${nurErgebnisse ? `, ${nurErgebnisse} nur Ergebnisse` : ''}${abos.some(a => a.teamIds?.length) ? `, ${abos.filter(a => a.teamIds?.length).length} mit Mannschaftsauswahl` : ''}${abos.some(a => a.teamIds?.length === 0) ? `, ${abos.filter(a => a.teamIds?.length === 0).length} noch ohne Auswahl` : ''}`,
    `Letzter Abruf: ${stand}`,
    `Letzter Fehler: ${fehler ? escapeHtml(fehler) : 'keiner'}`,
    `Zeitzone: ${tz.stand}${tz.detail ? ` (${escapeHtml(tz.detail)})` : ''}`,
    `Webhook: ${webhookZeile()}`,
    `Inline-Modus: ${inlineAn === true ? 'an' : inlineAn === false ? 'aus — im BotFather mit /setinline einschalten' : 'unbekannt'}`,
    `Nachzuholen: ${nachzuholen.lineupsMissing} Aufstellungen, ${nachzuholen.logosMissing} Logos`,
    `Zustellungen: ${bilanz.woche.ok} in 7 Tagen, ${bilanz.monat.ok} in 28 Tagen${bilanz.monat.fehl ? ` — ${bilanz.monat.fehl} gescheitert` : ''}`,
    `Microsite: ${micrositeZeile(now)}`,
  ];
  for (const f of bilanz.gescheitert.slice(0, 5)) {
    const wer = namen.get(f.chatId) ?? (abos.some(a => a.chatId === f.chatId) ? f.chatId : `${f.chatId} (ausgetragen)`);
    zeilen.push(`  ✕ ${escapeHtml(wer)}: ${escapeHtml(f.detail ?? 'unbekannt')} (${datum(new Date(f.sentAt), now)})`);
  }
  zeilen.push(`Feedback: ${feedback.length} Einträge, ${offene.length} offen`);
  for (const f of offene.slice(0, 5)) {
    zeilen.push(`  #${f.id} · ${datum(new Date(f.created_at), now)} · ${escapeHtml(f.name ?? f.chat_id)}: „${escapeHtml(f.text.slice(0, 120))}${f.text.length > 120 ? '…' : ''}"`);
  }
  return zeilen.join('\n');
}

/**
 * Eine Zeile zu den Browser-Abonnenten der Microsite (§7.3) — die einzige
 * Stelle außer der Cockpit-Karte, an der man sie sieht: Zahl, davon „nur
 * Ergebnisse", davon in den letzten 7 Tagen dazugekommen, davon mit
 * Zustellfehlern. Direkt aus der Tabelle, nicht über `handballSitePush`,
 * damit der Bot das Push-Modul nicht importieren muss.
 */
function micrositeZeile(now = new Date()): string {
  const abos = db.select().from(handball_site_subscription).all();
  if (abos.length === 0) return 'keine Browser-Abonnenten';
  const woche = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const neu = abos.filter(a => Date.parse(a.created_at) >= woche).length;
  const nurErgebnisse = abos.filter(a => a.mode === 'results').length;
  const wackelig = abos.filter(a => a.failures > 0).length;
  const teile = [`${abos.length} Browser-Abonnent${abos.length === 1 ? '' : 'en'}`];
  if (neu) teile.push(`${neu} neu in 7 Tagen`);
  if (nurErgebnisse) teile.push(`${nurErgebnisse} nur Ergebnisse`);
  if (wackelig) teile.push(`${wackelig} mit Zustellfehlern`);
  return teile.join(', ');
}

/** Eine Zeile zum Webhook für `/status` — dieselbe Quelle wie die Dienste-Zeile `handball_bot`. */
function webhookZeile(): string {
  const state = botRegistrationState();
  if (state.source === null) return 'kein Token';
  if (!state.registeredHere) return `nicht für diese Instanz registriert${state.storedFor ? ` (gespeichert für ${state.storedFor})` : ''}`;
  if (webhookZustand && !webhookZustand.ok) return `Registrierung gescheitert: ${webhookZustand.error ?? 'unbekannt'}`;
  const beiTelegram = handballWebhookBefund().zeile;
  return `${webhookZustand ? 'registriert' : 'registriert (in diesem Prozess nicht erneuert)'} · bei Telegram: ${escapeHtml(beiTelegram)}`;
}

// ---------------------------------------------------------------------------
// Eingehende Nachrichten
// ---------------------------------------------------------------------------

/** Was eine Zustellung außer Text und Knöpfen tragen kann. */
export interface SendExtras {
  /** Nachrichten-Effekt (🎉 zum Sieg) — nur in privaten Chats. */
  effectId?: string;
}

/** Ein Ort als Karte — die Halle. */
export interface HandballVenue {
  latitude: number;
  longitude: number;
  title: string;
  address: string;
}

export interface HandballBotDeps {
  /** Eine Nachricht, optional mit Knöpfen darunter; gibt die Nachrichten-ID zurück, wenn der Weg sie kennt. */
  send: (chatId: string, text: string, keyboard?: InlineKeyboard | null, extras?: SendExtras) => Promise<number | void>;
  /** Ein Bild mit Bildunterschrift; fehlt es (Tests), geht die Textfassung. */
  sendPhoto?: (chatId: string, png: Buffer, caption: string, filename?: string, keyboard?: InlineKeyboard | null, extras?: SendExtras) => Promise<number | void>;
  /** Eine Animation (GIF) mit Bildunterschrift; fehlt es, geht das Foto. */
  sendAnimation?: (chatId: string, gif: Buffer, caption: string, filename?: string, keyboard?: InlineKeyboard | null, extras?: SendExtras) => Promise<number | void>;
  /** „schickt ein Foto …" im Chat, solange gerendert wird — Beiwerk, nie abgewartet. */
  chatAction?: (chatId: string, action: ChatAction) => Promise<void>;
  /** Die Halle als Ort (`sendVenue`), still zugestellt. */
  sendVenue?: (chatId: string, venue: HandballVenue) => Promise<void>;
  /** Zwei bis zehn Bilder als ein Album; fehlt es, gehen sie einzeln. */
  sendMediaGroup?: (chatId: string, photos: Array<{ png: Buffer; filename: string; caption?: string }>) => Promise<void>;
  /** Antwort im Inline-Modus. */
  answerInline?: (inlineQueryId: string, results: InlineQueryResultPhoto[], opts: AnswerInlineQueryOptions) => Promise<void>;
  /** Eine Datei (Kalender); fehlt es, kommt der Spielplan als Text. */
  sendDocument?: (chatId: string, data: Buffer, filename: string, caption: string) => Promise<void>;
  /** Eine Emoji-Reaktion auf eine eigene Nachricht — Beiwerk, Fehler sind folgenlos. */
  react?: (chatId: string, messageId: number, emoji: string) => Promise<void>;
  /** Quittung für einen Knopfdruck, sonst dreht der Knopf minutenlang. */
  answerCallback?: (callbackId: string, text?: string) => Promise<void>;
}

/** Telegrams Obergrenze je Nachricht; etwas Luft für Entities. */
const TELEGRAM_MAX_CHARS = 4000;

/**
 * Eine zu lange Nachricht in Teile schneiden — an Absätzen, sonst an Zeilen,
 * damit kein HTML-Tag zerreißt. Telegram lehnt über 4096 Zeichen ab, und
 * ein abgelehnter Befehl war bis zum 26.09.2026 ein Befehl ohne Antwort.
 */
export function stuecke(text: string, max = TELEGRAM_MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let schnitt = rest.lastIndexOf('\n\n', max);
    if (schnitt < max / 2) schnitt = rest.lastIndexOf('\n', max);
    if (schnitt < max / 2) schnitt = max;
    out.push(rest.slice(0, schnitt));
    rest = rest.slice(schnitt).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

async function defaultSend(chatId: string, text: string, keyboard: InlineKeyboard | null = null, extras: SendExtras = {}): Promise<number | void> {
  const token = getHandballBotToken();
  if (!token) return;
  const teile = stuecke(text);
  let letzte: number | void = undefined;
  for (const [i, teil] of teile.entries()) {
    // Die Knöpfe unter den letzten Teil — bei einer gestückelten Nachricht gehören sie ans Ende; der Effekt an den ersten.
    const msg = await sendMessage(token, { chatId, text: teil, keyboard: i === teile.length - 1 ? keyboard : null, messageEffectId: i === 0 ? extras.effectId : undefined });
    letzte = msg?.message_id;
  }
  return letzte;
}

/**
 * PRF-2-004: Die `file_id` je hochgeladenem Bild. Ein Rundruf schickte
 * dasselbe PNG oder GIF (100 KB bis 1 MB) an jeden Chat neu hoch — bei 300
 * Chats bis zu 300 MB je Endstand. Jetzt geht es einmal hoch, danach nur die
 * `file_id`. Schlüssel ist das Buffer-Objekt: Der Bild-Zwischenspeicher gibt
 * für dasselbe Bild dasselbe zurück, und mit ihm fällt der Eintrag weg.
 */
const hochgeladen = new WeakMap<Buffer, string>();

async function mitWiederverwendung(art: 'photo' | 'animation', bild: Buffer, chatId: string, caption: string, keyboard: InlineKeyboard | null, extras: SendExtras, hochladen: () => Promise<TelegramMessage>): Promise<number | void> {
  const token = getHandballBotToken();
  if (!token) return;
  const fileId = hochgeladen.get(bild);
  if (fileId) {
    try {
      return (await sendFileIdAgain(token, art, fileId, { chatId, caption, keyboard, messageEffectId: extras.effectId })).message_id;
    } catch (err) {
      // Eine abgelehnte `file_id` heißt: neu hochladen. Alles andere (403, Chat weg) gilt wie beim Hochladen.
      if (!(err instanceof TelegramApiError) || err.status !== 400 || CHAT_WEG.test(err.message)) throw err;
      hochgeladen.delete(bild);
    }
  }
  const msg = await hochladen();
  const neu = art === 'photo' ? msg?.photo?.at(-1)?.file_id : msg?.animation?.file_id ?? msg?.document?.file_id;
  if (neu) hochgeladen.set(bild, neu);
  return msg?.message_id;
}

async function defaultSendPhoto(chatId: string, png: Buffer, caption: string, filename = 'bild.png', keyboard: InlineKeyboard | null = null, extras: SendExtras = {}): Promise<number | void> {
  return mitWiederverwendung('photo', png, chatId, caption, keyboard, extras,
    () => sendPhotoBytes(getHandballBotToken()!, { chatId, data: png, filename, contentType: 'image/png', caption, keyboard, messageEffectId: extras.effectId }));
}

async function defaultSendAnimation(chatId: string, gif: Buffer, caption: string, filename = 'bild.gif', keyboard: InlineKeyboard | null = null, extras: SendExtras = {}): Promise<number | void> {
  return mitWiederverwendung('animation', gif, chatId, caption, keyboard, extras,
    () => sendAnimationBytes(getHandballBotToken()!, { chatId, data: gif, filename, contentType: 'image/gif', caption, keyboard, messageEffectId: extras.effectId }));
}

/** Nur für Tests: die Standard-Sender für Foto und Animation. */
export const __defaultSendersForTests = { sendPhoto: defaultSendPhoto, sendAnimation: defaultSendAnimation };

async function defaultSendMediaGroup(chatId: string, photos: Array<{ png: Buffer; filename: string; caption?: string }>): Promise<void> {
  const token = getHandballBotToken();
  if (!token) return;
  await sendMediaGroupPhotos(token, chatId, photos.map(p => ({ data: p.png, filename: p.filename, contentType: 'image/png', caption: p.caption })));
}

async function defaultChatAction(chatId: string, action: ChatAction): Promise<void> {
  const token = getHandballBotToken();
  if (!token) return;
  await sendChatAction(token, chatId, action);
}

async function defaultSendVenue(chatId: string, venue: HandballVenue): Promise<void> {
  const token = getHandballBotToken();
  if (!token) return;
  await sendVenue(token, { chatId, ...venue, silent: true });
}

async function defaultAnswerInline(inlineQueryId: string, results: InlineQueryResultPhoto[], opts: AnswerInlineQueryOptions): Promise<void> {
  const token = getHandballBotToken();
  if (!token) return;
  await answerInlineQuery(token, inlineQueryId, results, opts);
}

async function defaultSendDocument(chatId: string, data: Buffer, filename: string, caption: string): Promise<void> {
  const token = getHandballBotToken();
  if (!token) return;
  await sendDocument(token, { chatId, data, filename, contentType: 'text/calendar', caption });
}

async function defaultReact(chatId: string, messageId: number, emoji: string): Promise<void> {
  const token = getHandballBotToken();
  if (!token) return;
  await setMessageReaction(token, chatId, messageId, emoji);
}

async function defaultAnswerCallback(callbackId: string, text?: string): Promise<void> {
  const token = getHandballBotToken();
  if (!token) return;
  await answerCallbackQuery(token, callbackId, text);
}

export const DEFAULT_DEPS: HandballBotDeps = {
  send: defaultSend, sendPhoto: defaultSendPhoto, sendAnimation: defaultSendAnimation, sendDocument: defaultSendDocument, react: defaultReact, answerCallback: defaultAnswerCallback,
  chatAction: defaultChatAction, sendVenue: defaultSendVenue, answerInline: defaultAnswerInline, sendMediaGroup: defaultSendMediaGroup,
};

/**
 * Die Anzeige „schickt ein Foto …" / „schreibt …" — abgeschickt, nicht
 * abgewartet, und kein Fehler kommt durch: Sie ist eine Höflichkeit, und
 * das Bild darf nicht auf sie warten. Nur bei Antworten an **einen** Chat;
 * Rundrufe und Meldungen an viele bekommen keine (ein Aufruf je Chat für
 * eine Anzeige, die niemand sieht, bevor die Nachricht da ist).
 */
function zeigeAktivitaet(chatId: string, action: ChatAction, deps: HandballBotDeps): void {
  try {
    const p = deps.chatAction?.(chatId, action);
    if (p) p.catch(() => { /* Beiwerk */ });
  } catch { /* Beiwerk */ }
}

/** Doppelte Zustellung abfangen — Telegram wiederholt Updates bei Timeout. */
const gesehen = new Set<number>();
const GESEHEN_MAX = 500;

function schonGesehen(updateId: number): boolean {
  if (gesehen.has(updateId)) return true;
  gesehen.add(updateId);
  if (gesehen.size > GESEHEN_MAX) {
    const erstes = gesehen.values().next().value;
    if (erstes !== undefined) gesehen.delete(erstes);
  }
  return false;
}

/** SEC-4-012: Rückmeldungen je Chat und Stunde, und wie lang eine sein darf. */
const FEEDBACK_JE_STUNDE = 3;
const FEEDBACK_FENSTER_MS = 60 * 60 * 1000;
const FEEDBACK_MAX_ZEICHEN = 1000;

/** Nur für Tests. */
export function __resetHandballBotForTests(): void {
  gesehen.clear();
  botIdentity.username = null;
  __resetHandballBotBasisForTests();
}

/**
 * SEC-4-013: Darf dieser Absender in diesem Chat die Betreiber-Befehle? Im
 * Privatchat ist die Chat-ID die des Nutzers. Ist eine Gruppe als Admin-Chat
 * eingetragen, bekommt sie die Meldungen — die Befehle darf darin aber nur,
 * wer selbst eingetragen ist; sonst schickte jedes Gruppenmitglied
 * `/rundruf` an alle Abonnenten.
 */
function darfBetreiben(chatId: string, vonId: string | null): boolean {
  if (!istAdmin(chatId)) return false;
  return !chatId.startsWith('-') || (vonId !== null && istAdmin(vonId));
}

async function antwortAufBefehl(text: string, chatId: string, name: string | null, deps: HandballBotDeps, vonId: string | null = null): Promise<void> {
  // Das Argument ist der Text nach dem ersten Wort, **mit** Zeilenumbrüchen —
  // ein mehrzeiliger `/rundruf` kam bis zum 27.09.2026 als ein Absatz an.
  const zerlegt = /^(\S+)\s*([\s\S]*)$/.exec(text.trim());
  const befehl = (zerlegt?.[1] ?? '').toLowerCase().replace(/@.*$/, '');
  const argument = (zerlegt?.[2] ?? '').trim();

  if (befehl === '/start') {
    const code = inviteCode();
    if (code && argument !== code) {
      await deps.send(chatId, 'Dieser Bot ist nicht öffentlich. Wer dich eingeladen hat, schickt dir einen Link, mit dem es klappt.');
      return;
    }
    const neu = subscribe(chatId, name);
    const sicht = handballOverview();
    // Ein neuer Chat verfolgt erst einmal nichts und wählt selbst — bei
    // mehreren Mannschaften wäre „alle" für fast jeden zu viel.
    const waehlen = neu && sicht.teams.length > 1;
    if (waehlen) setTeams(chatId, []);
    await deps.send(chatId, `${neu ? 'Willkommen! ' : 'Du bist schon dabei. '}${textHilfe(sicht.teams)}`, hilfeTastatur());
    if (waehlen) await deps.send(chatId, textTeams(sicht.teams, []), teamsTastatur(sicht.teams, []));
    return;
  }

  if (!istAbonnent(chatId)) {
    await deps.send(chatId, 'Schick /start, dann melde ich dir die Spiele.');
    return;
  }
  touch(chatId);

  if (befehl === '/stop') {
    unsubscribe(chatId);
    await deps.send(chatId, 'Alles klar, keine Meldungen mehr. /start holt dich zurück.');
    return;
  }

  // --- Befehle, die keine Mannschaft brauchen ---
  if (befehl === '/erinnerung') {
    const wahl = argument.toLowerCase().replace(/\s+/g, '');
    if (!wahl) {
      const abo = abonnent(chatId);
      await deps.send(chatId, `Wann soll ich vor dem Anwurf erinnern? Zurzeit: <b>${leadLabel(abo?.lead ?? DEFAULT_LEAD)}</b>.`, erinnerungTastatur());
      return;
    }
    const lead = (LEADS as readonly string[]).includes(wahl) ? (wahl as Lead) : wahl === 'vorabend' ? 'abend' : wahl === 'nie' || wahl === 'off' ? 'aus' : null;
    if (!lead) { await deps.send(chatId, 'Das kenne ich nicht — 1h, 3h, abend oder aus.', erinnerungTastatur()); return; }
    setLead(chatId, lead);
    await deps.send(chatId, lead === 'aus' ? 'Alles klar, keine Ankündigung mehr — Endstand und Verlegungen kommen weiter.' : `Alles klar, ich erinnere ${leadLabel(lead)}.`);
    return;
  }
  if (befehl === '/modus') {
    const wahl = argument.toLowerCase();
    if (!wahl) {
      const abo = abonnent(chatId);
      await deps.send(chatId, `Was soll ich dir schicken? Zurzeit: <b>${abo?.mode === 'results' ? 'nur Ergebnisse' : 'alles'}</b>.`, modusTastatur());
      return;
    }
    const mode: Mode | null = /^(alles|all|voll)$/.test(wahl) ? 'all' : /^(ergebnisse|results|nur|endstand)$/.test(wahl) ? 'results' : null;
    if (!mode) { await deps.send(chatId, 'Das kenne ich nicht — alles oder ergebnisse.', modusTastatur()); return; }
    setMode(chatId, mode);
    await deps.send(chatId, mode === 'results'
      ? 'Alles klar: nur noch Endstand, Spielbericht und Verlegungen. /modus alles holt den Rest zurück.'
      : 'Alles klar: Ankündigung, Aufstellung, Halbzeit, Endstand, Bericht und Verlegungen.');
    return;
  }
  if (befehl === '/teams' || befehl === '/mannschaften') {
    const alle = handballOverview().teams;
    if (alle.length === 0) { await deps.send(chatId, 'Es ist noch keine Mannschaft eingetragen.'); return; }
    const wahl = argument.toLowerCase().trim();
    const abo = abonnent(chatId);
    if (wahl === 'alle') {
      setTeams(chatId, null);
    } else if (/^\d{1,12}$/.test(wahl) && alle.some(t => t.team_id === wahl)) {
      const aktuell = new Set(abo?.teamIds ?? alle.map(t => t.team_id));
      if (aktuell.has(wahl)) aktuell.delete(wahl); else aktuell.add(wahl);
      if (aktuell.size === 0) {
        // Gar keine Mannschaft ist kein Abonnement — das ist /stop, nicht /teams.
        await deps.send(chatId, 'Eine Mannschaft muss bleiben — wer gar nichts mehr will, schickt /stop.', teamsTastatur(alle, abo?.teamIds ?? null));
        return;
      }
      setTeams(chatId, aktuell.size === alle.length ? null : alle.map(t => t.team_id).filter(id => aktuell.has(id)));
    }
    const gewaehlt = abonnent(chatId)?.teamIds ?? null;
    await deps.send(chatId, textTeams(alle, gewaehlt), teamsTastatur(alle, gewaehlt));
    return;
  }
  if (befehl === '/feedback') {
    if (!argument) { await deps.send(chatId, 'Schreib dein Feedback hinter den Befehl: /feedback Die Halbzeit kommt zu spät.'); return; }
    // SEC-4-012: Jeder Abonnent kann schreiben (ohne Einladungscode jeder), und jede Zeile ging an alle
    // Admin-Chats — ohne Drossel ein Kanal, um Tabelle und Betreiber zu fluten.
    const seit = new Date(Date.now() - FEEDBACK_FENSTER_MS).toISOString();
    const juengst = db.select({ id: handball_bot_feedback.id }).from(handball_bot_feedback)
      .where(and(eq(handball_bot_feedback.chat_id, chatId), gte(handball_bot_feedback.created_at, seit))).all().length;
    if (juengst >= FEEDBACK_JE_STUNDE) {
      await deps.send(chatId, `Danke! Mehr als ${FEEDBACK_JE_STUNDE} Rückmeldungen in der Stunde nehme ich nicht an — versuch es später noch einmal.`);
      return;
    }
    const text = argument.length > FEEDBACK_MAX_ZEICHEN ? `${argument.slice(0, FEEDBACK_MAX_ZEICHEN)}…` : argument;
    db.insert(handball_bot_feedback).values({ chat_id: chatId, name, text, created_at: new Date().toISOString() }).run();
    for (const admin of adminChatIds()) {
      try { await deps.send(admin, `💬 <b>Feedback</b> von ${escapeHtml(name ?? chatId)} (Chat <code>${escapeHtml(chatId)}</code>):\n${escapeHtml(text)}`); } catch { /* der Betreiber ist nicht erreichbar — der Eintrag steht in der Datenbank */ }
    }
    await deps.send(chatId, 'Danke, ist angekommen.');
    return;
  }
  if (befehl === '/status') {
    if (!darfBetreiben(chatId, vonId)) {
      await deps.send(chatId, `Deine Chat-ID ist <code>${escapeHtml(chatId)}</code>. In TELEGRAM_ADMIN_CHAT_IDS eingetragen, zeigt /status hier den Betriebsstand.`);
      return;
    }
    zeigeAktivitaet(chatId, 'typing', deps);
    await inlineStandErfragen();
    await refreshHandballWebhookInfo();
    await deps.send(chatId, textStatus(handballOverview()), statusTastatur(offeneRueckmeldungen()));
    return;
  }
  if (befehl === '/erledigt') {
    if (!darfBetreiben(chatId, vonId)) { await deps.send(chatId, 'Das darf nur der Betreiber.'); return; }
    const id = Number.parseInt(argument, 10);
    const zeile = Number.isFinite(id) ? db.select().from(handball_bot_feedback).where(eq(handball_bot_feedback.id, id)).get() : undefined;
    if (!zeile) { await deps.send(chatId, 'Welche Rückmeldung? /erledigt 12 — die Nummern stehen unter /status.'); return; }
    if (!zeile.done_at) db.update(handball_bot_feedback).set({ done_at: new Date().toISOString() }).where(eq(handball_bot_feedback.id, id)).run();
    const offen = offeneRueckmeldungen().length;
    await deps.send(chatId, `Rückmeldung #${id} erledigt${offen ? ` — ${offen} noch offen` : ' — keine mehr offen'}.`, statusTastatur(offeneRueckmeldungen()));
    return;
  }
  if (befehl === '/rundruf') {
    if (!darfBetreiben(chatId, vonId)) { await deps.send(chatId, 'Das darf nur der Betreiber.'); return; }
    if (!argument) { await deps.send(chatId, 'Text hinter den Befehl: /rundruf Ab jetzt gibt es den Halbzeitstand.'); return; }
    const n = await rundsenden(`📣 <b>Info vom Betreiber</b>\n${escapeHtml(argument)}`, deps, null, ALLE, 'rundruf');
    await deps.send(chatId, `Rundruf an ${n} Chat${n === 1 ? '' : 's'} geschickt.`);
    return;
  }

  const sicht = handballOverview();
  if (!sicht.configured || sicht.teams.length === 0) {
    await deps.send(chatId, 'Es ist noch keine Mannschaft eingetragen.');
    return;
  }
  // Befehle antworten für die Mannschaften, die der Chat verfolgt (`/teams`).
  // Hat er noch keine gewählt, kommt zuerst die Auswahl.
  if (befehl !== '/hilfe' && befehl !== '/help' && abonnent(chatId)?.teamIds?.length === 0 && sicht.teams.length > 1) {
    await deps.send(chatId, textTeams(sicht.teams, []), teamsTastatur(sicht.teams, []));
    return;
  }
  const teams = meineTeams(chatId, sicht.teams);

  switch (befehl) {
    case '/spiele':
      await spieleSenden(chatId, teams, deps);
      return;
    case '/saison':
      await saisonAlleSenden(chatId, teams, deps);
      return;
    case '/saisonkarte':
      await saisonkartenSenden(chatId, teams, deps);
      return;
    case '/torjaeger':
    case '/torjäger':
      await torjaegerAlleSenden(chatId, teams, deps);
      return;
    case '/rekorde':
      zeigeAktivitaet(chatId, 'typing', deps);
      await deps.send(chatId, teams.map(team => textRekorde(team, playerGames(team.team_id))).join('\n\n'));
      return;
    case '/kalender': {
      if (deps.sendDocument) zeigeAktivitaet(chatId, 'upload_document', deps);
      for (const team of teams) {
        const ics = icsKalender(team);
        if (deps.sendDocument) {
          try {
            await deps.sendDocument(chatId, Buffer.from(ics, 'utf8'), `${team.name.replace(/[^\w.-]+/g, '_')}.ics`, `🗓 Alle Spiele von ${escapeHtml(team.name)} — antippen und in den Kalender übernehmen. Nach einer Verlegung einfach neu holen.`);
            continue;
          } catch (err) {
            serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Kalender nicht zustellbar — Textfassung');
          }
        }
        await deps.send(chatId, textSpiele([team]));
      }
      return;
    }
    case '/live': {
      zeigeAktivitaet(chatId, 'typing', deps);
      const jetzt = Date.now();
      let gefunden = false;
      for (const team of teams) {
        const laufend = team.matches.find(m => m.status === 'live'
          || (m.status === 'scheduled' && jetzt >= Date.parse(m.starts_at) && jetzt - Date.parse(m.starts_at) <= LIVE_WINDOW_MS));
        if (!laufend) continue;
        gefunden = true;
        try {
          const events = await fetchMatchEvents(laufend.match_id);
          merkeAnwurfSchaetzung(team.team_id, laufend.match_id, events);
          await deps.send(chatId, textLive(team, laufend, events), halbzeitTastatur());
        } catch (err) {
          serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Torfolge auf Anfrage nicht abrufbar');
          await deps.send(chatId, 'handball.net antwortet gerade nicht — gleich noch einmal versuchen.');
        }
      }
      if (!gefunden) await deps.send(chatId, `Gerade läuft kein Spiel.\n\n${textSpiele(teams)}`);
      return;
    }
    case '/ergebnisse':
      zeigeAktivitaet(chatId, 'typing', deps);
      await deps.send(chatId, textErgebnisse(teams));
      return;
    case '/tabelle':
      await tabellenSenden(chatId, teams, deps);
      return;
    case '/kader':
      await kaderAlleSenden(chatId, teams, deps);
      return;
    case '/spieler':
      // Ohne Namen die Torjäger mit einem Knopf je Spieler — tippen statt tippen.
      if (!argument) { await torjaegerAlleSenden(chatId, teams, deps); return; }
      for (const team of teams) await spielerSenden(chatId, team, argument, deps);
      return;
    case '/halle':
      await halleSenden(chatId, teams, deps, argument);
      return;
    case '/bericht': {
      zeigeAktivitaet(chatId, 'typing', deps);
      const teile: string[] = [];
      for (const team of teams) {
        const letztes = [...team.matches].reverse().find(m => m.status === 'finished');
        if (!letztes) { teile.push(`<b>${escapeHtml(team.name)}</b>\nNoch kein Spiel in dieser Saison.`); continue; }
        // Fehlt der Text noch, einmal holen — die eine Ausnahme von „kein
        // Aufruf für einen Befehl", siehe `ensureMatchReport`.
        let text = letztes.report_text;
        if (!text) {
          try { text = await ensureMatchReport(team.team_id, letztes.match_id); } catch (err) {
            serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Spielbericht auf Anfrage nicht abrufbar');
          }
        }
        if (text) {
          const voll = /^(voll|alles|ganz)$/i.test(argument);
          await deps.send(chatId, textBericht(team, { ...letztes, report_text: text }, voll ? 'voll' : 'kurz'), berichtTastatur(letztes, !voll));
          continue;
        }
        const bogen = letztes.report_url ? `\n<a href="${escapeHtml(letztes.report_url)}">Spielberichtsbogen (PDF)</a>` : '';
        teile.push(`<b>${escapeHtml(team.name)}</b>\nZum Spiel ${letztes.is_home ? 'gegen' : 'bei'} ${escapeHtml(gegnerVon(letztes))} gibt es noch keinen Spielbericht — er kommt, sobald handball.net ihn schreibt.${bogen}`);
      }
      if (teile.length > 0) await deps.send(chatId, teile.join('\n\n'));
      return;
    }
    case '/hilfe':
    case '/help':
      await deps.send(chatId, textHilfe(sicht.teams), hilfeTastatur());
      return;
    default:
      await deps.send(chatId, `Das kenne ich nicht. ${textHilfe(sicht.teams)}`, hilfeTastatur());
  }
}

function leadLabel(lead: Lead): string {
  return lead === '1h' ? 'eine Stunde vorher' : lead === '3h' ? 'drei Stunden vorher' : lead === 'abend' ? 'am Vorabend um 19 Uhr' : 'gar nicht';
}

/** Wann die Ankündigung für einen Chat fällig ist — null bei „aus". */
export function ankuendigungFaelligAb(startsAt: string, lead: Lead): number | null {
  const start = Date.parse(startsAt);
  if (lead === 'aus') return null;
  if (lead === '1h') return start - 60 * 60 * 1000;
  if (lead === '3h') return start - 3 * 60 * 60 * 1000;
  // Vorabend 19 Uhr Ortszeit: den Berliner Kalendertag des Anwurfs um einen Tag zurück, dann 19:00 als Ortszeit nach UTC.
  const tag = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(start - 24 * 60 * 60 * 1000));
  return Date.parse(sourceTimeToUtc(`${tag}T19:00:00`));
}

function istGruppe(chat: { type: string }): boolean {
  return chat.type === 'group' || chat.type === 'supergroup';
}

/**
 * Ein Update aus dem Webhook. Textnachrichten in privaten Chats und in
 * Gruppen; alles andere wird still verworfen — der Bot hat keine Knöpfe
 * (bis auf Links) und keine Dialoge.
 *
 * In einer Gruppe ist der Bot der Kanal, den nicht jeder einzeln abonnieren
 * muss: `/start` trägt die Gruppe ein (unter ihrem Titel), Befehle kommen
 * dort als `/tabelle@botname` und werden genauso verstanden. Freitext in einer
 * Gruppe bleibt unbeantwortet — „Ich verstehe nur Befehle" in einer
 * Elterngruppe wäre nach dem dritten Mal Spam. Wird der Bot aus der Gruppe
 * entfernt, fliegt sie aus der Liste (`my_chat_member`).
 */
export async function handleHandballUpdate(update: TelegramUpdate, deps: HandballBotDeps = DEFAULT_DEPS): Promise<void> {
  if (typeof update.update_id !== 'number' || schonGesehen(update.update_id)) return;
  if (update.inline_query) {
    try {
      await antwortInline(update.inline_query, deps);
    } catch (err) {
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Inline-Antwort fehlgeschlagen');
    }
    return;
  }
  const mitglied = update.my_chat_member;
  if (mitglied && istGruppe(mitglied.chat)) {
    const status = mitglied.new_chat_member?.status;
    if (status === 'left' || status === 'kicked') {
      if (unsubscribe(String(mitglied.chat.id))) serviceLog.info({ chat: mitglied.chat.id }, '[handball-bot] Aus einer Gruppe entfernt — ausgetragen');
    }
    return;
  }
  const cb = update.callback_query;
  if (cb) {
    // Ein Knopfdruck: quittieren, dann wie den Befehl behandeln, für den der Knopf steht.
    try { await deps.answerCallback?.(cb.id); } catch { /* Quittung ist Beiwerk */ }
    const m = /^cmd:([a-z]+)(?::(.*))?$/.exec(cb.data ?? '');
    const chat = cb.message?.chat;
    if (!m || !chat) return;
    const chatId = String(chat.id);
    const name = istGruppe(chat) ? (chat.title ? `Gruppe: ${chat.title}` : 'Gruppe') : (cb.from.first_name ?? cb.from.username ?? null);
    try {
      await antwortAufBefehl(`/${m[1]}${m[2] ? ` ${m[2]}` : ''}`, chatId, name, deps, String(cb.from.id));
    } catch (err) {
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Antwort auf Knopf fehlgeschlagen');
    }
    return;
  }
  const message = update.message;
  if (!message?.from || message.from.is_bot) return;
  const text = (message.text ?? '').trim();
  if (!text) return;
  const chatId = String(message.chat.id);
  const gruppe = istGruppe(message.chat);
  const name = gruppe
    ? (message.chat.title ? `Gruppe: ${message.chat.title}` : 'Gruppe')
    : (message.from.first_name ?? message.from.username ?? null);
  try {
    if (text.startsWith('/')) {
      await antwortAufBefehl(text, chatId, name, deps, String(message.from.id));
    } else if (gruppe) {
      return;
    } else if (istAbonnent(chatId)) {
      touch(chatId);
      await deps.send(chatId, `Ich verstehe nur Befehle. ${textHilfe(handballOverview().teams)}`, hilfeTastatur());
    } else {
      await deps.send(chatId, 'Schick /start, dann melde ich dir die Spiele.');
    }
  } catch (err) {
    serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Antwort fehlgeschlagen');
  }
}

// ---------------------------------------------------------------------------
// Inline-Modus — `@bot tab` in jedem Chat (sechste Runde, 27.09.2026)
// ---------------------------------------------------------------------------

/** Was der Inline-Modus anbietet — je Art ein Bild, das es auch als Befehl gibt. */
export const INLINE_ARTEN = ['tabelle', 'spiel', 'endstand', 'kader', 'torjaeger'] as const;
export type InlineArt = typeof INLINE_ARTEN[number];

const INLINE_INFO: Record<InlineArt, { titel: string; emoji: string; stichworte: string[] }> = {
  tabelle: { titel: 'Tabelle', emoji: '📊', stichworte: ['tabelle', 'platz', 'liga', 'rang'] },
  spiel: { titel: 'Nächstes Spiel', emoji: '📅', stichworte: ['spiel', 'nächstes', 'naechstes', 'next', 'anwurf', 'termin'] },
  endstand: { titel: 'Letzter Endstand', emoji: '🏁', stichworte: ['endstand', 'ergebnis', 'letztes', 'resultat', 'stand'] },
  kader: { titel: 'Kader', emoji: '👥', stichworte: ['kader', 'mannschaft', 'team', 'spieler'] },
  torjaeger: { titel: 'Torjäger', emoji: '🥇', stichworte: ['torjäger', 'torjaeger', 'tore', 'torschützen', 'torschuetzen', 'scorer'] },
};

/** Wie lange ein Bild-Link aus dem Inline-Modus gilt. */
const INLINE_GUELTIG_MS = 24 * 60 * 60 * 1000;
const STUNDE_MS = 60 * 60 * 1000;

/**
 * Der Schlüssel der Bild-Links: abgeleitet aus dem Header-Geheimnis der
 * Bot-Instanz (zufällig, nur in der Datenbank, nie in einer URL) mit eigenem
 * Zweck, damit dieselben Bytes nicht zwei Aufgaben haben.
 */
function inlineSchluessel(): Buffer {
  return crypto.createHmac('sha256', ensureHandballBotSecrets().webhookHeaderSecret).update('handball-inline-bild').digest();
}

export function inlineSignatur(art: string, teamId: string, exp: number): string {
  return crypto.createHmac('sha256', inlineSchluessel()).update(`${art}\n${teamId}\n${exp}`).digest('base64url');
}

/**
 * Die signierte URL eines Inline-Bildes. `exp` (Sekunden) ist auf die volle
 * Stunde gerundet: Die URL wechselt höchstens stündlich — Telegram hält ein
 * Bild je URL vor, und so zeigt eine neue Tabelle spätestens nach einer
 * Stunde auch im Inline-Modus den neuen Stand.
 */
export function inlineBildUrl(art: InlineArt, teamId: string, now = new Date(), vorschau = false): string {
  const exp = Math.ceil((now.getTime() + INLINE_GUELTIG_MS) / STUNDE_MS) * STUNDE_MS / 1000;
  const q = new URLSearchParams({ team: teamId, exp: String(exp), t: inlineSignatur(art, teamId, exp) });
  if (vorschau) q.set('vorschau', '1');
  return `${publicUrl()}/inline/${art}.jpg?${q.toString()}`;
}

/** Prüft einen Bild-Link: Signatur zeitkonstant, Ablauf nicht vorbei und nicht weiter weg als die Gültigkeit plus eine Stunde. */
export function pruefeInlineSignatur(art: string, teamId: string, expRoh: string, t: string, now = Date.now()): boolean {
  if (!(INLINE_ARTEN as readonly string[]).includes(art) || !/^\d{9,11}$/.test(expRoh) || typeof t !== 'string') return false;
  const exp = Number(expRoh);
  if (exp * 1000 <= now || exp * 1000 > now + INLINE_GUELTIG_MS + STUNDE_MS) return false;
  const soll = Buffer.from(inlineSignatur(art, teamId, exp), 'utf8');
  const ist = Buffer.from(t, 'utf8');
  return soll.length === ist.length && crypto.timingSafeEqual(soll, ist);
}

/** Gibt es für diese Art gerade etwas zu zeichnen? Billig — ohne SVG, wo es geht. */
function inlineVerfuegbar(team: HandballTeamView, art: InlineArt): boolean {
  switch (art) {
    case 'tabelle': return (team.standings[0]?.rows.length ?? 0) > 0;
    case 'spiel': return !!team.next_match && !team.next_match.is_live;
    case 'endstand': return !!team.last_match && team.last_match.score_home !== null && team.last_match.score_away !== null;
    case 'kader': return bildKader(team) !== null;
    case 'torjaeger': return playerStats(team.team_id).some(p => p.goals > 0);
  }
}

/**
 * Das SVG einer Inline-Art — dieselben Bilder wie Befehle und Cockpit.
 * Null: gerade nichts zu zeichnen.
 */
export async function inlineBildSvg(team: HandballTeamView, art: InlineArt): Promise<string | null> {
  if (!inlineVerfuegbar(team, art)) return null;
  switch (art) {
    case 'tabelle': return bildTabelle(team, team.standings[0]);
    case 'spiel': return bildSpiel(team.next_match!);
    case 'endstand': {
      const m = team.last_match!;
      const bester = playerGames(team.team_id).filter(g => g.matchId === m.match_id).sort((a, b) => b.goals - a.goals)[0];
      return endstandBild(team, m, { playerOfMatch: bester && bester.goals > 0 ? `${bester.name} · ${bester.goals} Tor${bester.goals === 1 ? '' : 'e'}` : null });
    }
    case 'kader': return bildKader(team);
    case 'torjaeger': return bildTorjaeger(team);
  }
}

function inlineUnterschrift(team: HandballTeamView, art: InlineArt): { beschreibung: string; caption: string } {
  const info = INLINE_INFO[art];
  const kopf = `${info.emoji} <b>${escapeHtml(team.name)}</b> — ${info.titel}`;
  if (art === 'spiel' && team.next_match) {
    const m = team.next_match;
    const zeile = `${DATUM.format(new Date(m.starts_at))} ${ZEIT.format(new Date(m.starts_at))} Uhr, ${m.is_home ? 'gegen' : 'bei'} ${gegnerVon(m)}`;
    return { beschreibung: zeile, caption: `${kopf}\n${escapeHtml(zeile)}` };
  }
  if (art === 'endstand' && team.last_match) {
    const m = team.last_match;
    const zeile = `${m.score_home}:${m.score_away} ${m.is_home ? 'gegen' : 'bei'} ${gegnerVon(m)}`;
    return { beschreibung: zeile, caption: `${kopf}\n${escapeHtml(zeile)}` };
  }
  const wettbewerb = wettbewerbVon(team);
  return { beschreibung: wettbewerb ?? team.name, caption: kopf };
}

function passtZurSuche(art: InlineArt, suche: string): boolean {
  const q = suche.trim().toLowerCase();
  if (!q) return true;
  return q.split(/\s+/).every(wort => INLINE_INFO[art].stichworte.some(w => w.startsWith(wort) || wort.startsWith(w)));
}

/**
 * Eine Inline-Anfrage: Wer den Bot abonniert hat (privater Chat mit seiner
 * Nutzer-ID), bekommt die passenden Bilder; wer nicht, eine leere Liste mit
 * dem Knopf „Bot starten". So erzeugt kein Fremder über den Bot Karten —
 * und wer ihn weiterempfiehlt, landet beim `/start` (mit Einladungscode
 * danach nur, wer den Code hat).
 *
 * `is_personal: true`, obwohl die Bilder für alle gleich sind: Die Antwort
 * hängt davon ab, **wer** fragt, und ohne das hielte Telegram die Antwort je
 * Suchtext vor — ein Fremder bekäme die zwischengespeicherten Karten eines
 * Abonnenten, und ein Abonnent die leere Liste eines Fremden.
 */
async function antwortInline(q: TelegramInlineQuery, deps: HandballBotDeps, now = new Date()): Promise<void> {
  if (!deps.answerInline) return;
  const opts: AnswerInlineQueryOptions = { cacheTime: 300, isPersonal: true };
  if (!istAbonnent(String(q.from.id))) {
    await deps.answerInline(q.id, [], { ...opts, button: { text: 'Bot starten', start_parameter: 'inline' } });
    return;
  }
  const sicht = handballOverview();
  const ergebnisse: InlineQueryResultPhoto[] = [];
  for (const team of sicht.configured ? meineTeams(String(q.from.id), sicht.teams) : []) {
    for (const art of INLINE_ARTEN) {
      if (!passtZurSuche(art, q.query ?? '') || !inlineVerfuegbar(team, art)) continue;
      const { beschreibung, caption } = inlineUnterschrift(team, art);
      ergebnisse.push({
        type: 'photo',
        id: `${art}:${team.team_id}`.slice(0, 64),
        photo_url: inlineBildUrl(art, team.team_id, now),
        thumbnail_url: inlineBildUrl(art, team.team_id, now, true),
        title: `${INLINE_INFO[art].titel}${sicht.teams.length > 1 ? ` — ${team.label}` : ''}`,
        description: beschreibung,
        caption,
        parse_mode: 'HTML',
      });
    }
  }
  await deps.answerInline(q.id, ergebnisse.slice(0, 50), opts);
}

/** Für `/status`: ob der Inline-Modus eingeschaltet ist — einmal je Prozess erfragt. */
async function inlineStandErfragen(): Promise<void> {
  if (inlineAn !== null) return;
  const token = getHandballBotToken();
  if (!token) return;
  try {
    const ich = await getMe(token);
    if (!botIdentity.username && ich.username) botIdentity.username = ich.username;
    setzeInlineAn(typeof ich.supports_inline_queries === 'boolean' ? ich.supports_inline_queries : null);
  } catch { /* bleibt „unbekannt" */ }
}

// ---------------------------------------------------------------------------
// Meldungen von sich aus
// ---------------------------------------------------------------------------

export function schonGeschickt(id: string): boolean {
  return !!db.select().from(handball_bot_sent).where(eq(handball_bot_sent.id, id)).get();
}

export function merke(id: string): void {
  db.insert(handball_bot_sent).values({ id, sent_at: new Date().toISOString() }).onConflictDoNothing().run();
}

/**
 * An alle Abonnenten. Wer den Bot blockiert hat (403), fliegt aus der Liste —
 * sonst kostet jede Meldung einen Fehlversuch mehr, für immer.
 */
type Empfaenger = (abo: HandballSubscriber) => boolean;
/** Alle; und nur die, die alles wollen — Ankündigung, Aufstellung und Halbzeit gehen nicht an „nur Ergebnisse". */
export const ALLE: Empfaenger = () => true;
export const NUR_ALLES: Empfaenger = abo => abo.mode === 'all';
/** Dazu die Auswahl aus `/teams`: eine Meldung zu einer Mannschaft geht nur an die, die sie verfolgen. */
export const fuerTeam = (teamId: string, wer: Empfaenger): Empfaenger => abo => wer(abo) && verfolgt(abo, teamId);

/** Was der Bot von sich aus schickt — der Schlüssel im Zustell-Protokoll. */
type Meldungsart = 'ankuendigung' | 'aufstellung' | 'halbzeit' | 'endstand' | 'bericht' | 'aenderung' | 'rundruf' | 'saison';

/** Aufbewahrung des Zustell-Protokolls. */
const DELIVERY_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Eine Zustellung protokollieren, gelungen oder nicht — `/status` zählt
 * daraus. Bei einem Fehlschlag die Telegram-Meldung, gekürzt.
 */
export function protokolliere(chatId: string, art: Meldungsart, ok: boolean, err?: unknown): void {
  const detail = ok ? null : (err instanceof Error ? err.message : String(err)).slice(0, 160);
  db.insert(handball_bot_delivery).values({ chat_id: chatId, kind: art, ok: ok ? 1 : 0, detail, sent_at: new Date().toISOString() }).run();
}

export function protokollAufraeumen(now: Date): void {
  db.delete(handball_bot_delivery).where(lt(handball_bot_delivery.sent_at, new Date(now.getTime() - DELIVERY_KEEP_MS).toISOString())).run();
}

export async function rundsenden(text: string, deps: HandballBotDeps, keyboard: InlineKeyboard | null, wer: Empfaenger, art: Meldungsart): Promise<number> {
  return (await anAlle(chatId => deps.send(chatId, text, keyboard), wer, art)).count;
}

/**
 * Ein Bild an alle, mit dem Text als Unterschrift — passt er nicht in eine,
 * folgt er als Nachricht. Scheitert das Bild, kommt der Text allein: Ein
 * Endstand ohne Bild ist besser als keiner.
 */
export async function rundsendenBild(png: Buffer, text: string, filename: string, deps: HandballBotDeps, keyboard: InlineKeyboard | null, wer: Empfaenger, art: Meldungsart, gif: Buffer | null = null, effekt: string | null = null): Promise<Zustellung> {
  return anAlle(async chatId => {
    if (!deps.sendPhoto) return mitEffekt(chatId, effekt, x => deps.send(chatId, text, keyboard, x));
    const sendPhoto = deps.sendPhoto;
    const passt = text.length <= CAPTION_MAX_CHARS;
    const caption = passt ? text : text.split('\n')[0];
    let id: number | void;
    try {
      // Erst die Animation; lehnt Telegram sie ab (zu groß, Format), kommt das Foto — ein 403 bleibt ein 403.
      if (gif && deps.sendAnimation) {
        const sendAnimation = deps.sendAnimation;
        try {
          id = await mitEffekt(chatId, effekt, x => sendAnimation(chatId, gif, caption, filename.replace(/\.png$/, '.gif'), keyboard, x));
        } catch (err) {
          if (err instanceof TelegramApiError && (err.status === 403 || err.status === 400 && CHAT_WEG.test(err.message))) throw err;
          serviceLog.warn({ err: err instanceof Error ? err.message : String(err), chat: chatId }, '[handball-bot] Animation nicht zustellbar — Foto');
          id = await mitEffekt(chatId, effekt, x => sendPhoto(chatId, png, caption, filename, keyboard, x));
        }
      } else {
        id = await mitEffekt(chatId, effekt, x => sendPhoto(chatId, png, caption, filename, keyboard, x));
      }
    } catch (err) {
      if (err instanceof TelegramApiError) throw err;
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Bild nicht zustellbar — Textfassung');
      return mitEffekt(chatId, effekt, x => deps.send(chatId, text, keyboard, x));
    }
    if (!passt) await deps.send(chatId, text);
    return id;
  }, wer, art);
}

/** Telegram-Meldungen, die heißen: Dieser Chat ist weg — nie wiederholen. */
const CHAT_WEG = /chat not found|kicked|deactivated/i;

/**
 * 🎉 als Nachrichten-Effekt. Die ID ist keine dokumentierte Konstante,
 * sondern eine der Standard-Effekte, die Telegram-Clients seit Bot API 7.4
 * anbieten (🔥 5104841245755180586, 👍 5107584321108051014, 🎉 diese); sie
 * gilt als stabil, aber niemand garantiert es. Lehnt Telegram sie ab (400),
 * geht dieselbe Nachricht ohne Effekt noch einmal — der Endstand darf nie
 * an einer Verzierung scheitern.
 */
export const KONFETTI_EFFECT_ID = '5046509860389126442';

/**
 * Eine Zustellung mit Effekt — nur in privaten Chats (positive ID; Gruppen
 * lehnen Effekte ab). Ein 400 mit Effekt führt zu genau einem zweiten
 * Versuch ohne; alles andere geht unverändert an den Aufrufer.
 */
export async function mitEffekt<T>(chatId: string, effekt: string | null, sende: (extras?: SendExtras) => Promise<T>): Promise<T> {
  if (!effekt || chatId.startsWith('-')) return sende();
  try {
    return await sende({ effectId: effekt });
  } catch (err) {
    if (err instanceof TelegramApiError && err.status === 400 && !CHAT_WEG.test(err.message)) {
      serviceLog.info({ chat: chatId, err: err.message }, '[handball-bot] Effekt abgelehnt — noch einmal ohne');
      return sende();
    }
    throw err;
  }
}

/**
 * Eine gescheiterte Zustellung einordnen. 403: blockiert (Privatchat) oder
 * rausgeworfen (Gruppe). 400 „chat not found": die Gruppe ist gelöscht oder
 * zur Supergruppe geworden — dann kommt sie mit neuer ID wieder, wenn dort
 * jemand /start schickt. Beides trägt aus, sonst kostet jede Meldung für
 * immer einen Fehlversuch mehr.
 */
export function zustellungGescheitert(chatId: string, err: unknown): void {
  const weg = err instanceof TelegramApiError
    && (err.status === 403 || (err.status === 400 && CHAT_WEG.test(err.message)));
  if (weg) {
    unsubscribe(chatId);
    serviceLog.info({ chat: chatId }, '[handball-bot] Chat nicht mehr erreichbar (blockiert oder entfernt) — ausgetragen');
    return;
  }
  serviceLog.warn({ chat: chatId, err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Zustellung fehlgeschlagen');
}

export async function anAlle(sende: (chatId: string) => Promise<number | void>, wer: Empfaenger, art: Meldungsart): Promise<Zustellung> {
  const out: Zustellung = { count: 0, sent: [] };
  for (const abo of listSubscribers()) {
    if (!wer(abo)) continue;
    try {
      const id = await sende(abo.chatId);
      out.count++;
      if (typeof id === 'number') out.sent.push({ chatId: abo.chatId, messageId: id });
      protokolliere(abo.chatId, art, true);
    } catch (err) {
      protokolliere(abo.chatId, art, false, err);
      zustellungGescheitert(abo.chatId, err);
    }
  }
  return out;
}
