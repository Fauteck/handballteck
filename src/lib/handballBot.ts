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
import { eq, gte, isNull, lt } from 'drizzle-orm';
import { db } from '../db';
import {
  handball_bot_instance, handball_bot_subscriber, handball_bot_sent, handball_bot_feedback, handball_bot_delivery,
  handball_site_subscription,
} from '../db/schema';
import {
  sendMessage, sendPhotoBytes, sendAnimationBytes, sendDocument, setMessageReaction, answerCallbackQuery, setWebhook, setMyCommands,
  deleteMyCommands, getMe, escapeHtml, TelegramApiError, sendChatAction, sendVenue, answerInlineQuery, sendMediaGroupPhotos,
  getWebhookInfo, type TelegramWebhookInfo, setMyDescription, setMyShortDescription, BOT_DESCRIPTION_MAX, BOT_SHORT_DESCRIPTION_MAX,
  type TelegramUpdate, type TelegramInlineQuery, type BotCommand, type InlineKeyboard, type ChatAction, type InlineQueryResultPhoto,
  type AnswerInlineQueryOptions,
} from './telegramClient';
import { renderPng } from './handballTableImage';
import {
  fetchLineups, fetchMatchEvents, fetchMatchReport, fetchTeamMatches, sourceTimeToUtc, type HandballLineupSide, type HandballMatch,
} from './handballNetClient';
import {
  handballOverview, rosterFor, changesFor, storeLineup, playerStats, setzeHalbzeit, setzeBericht, ensureMatchReport, backlogFor,
  getHandballHealth, playerGames, opponentFormFor, merkeAnwurfSchaetzung, zeitzonenStand, saisonVorbei, type HandballMatchView,
  type HandballTeamView, type HandballStandingsView,
} from './handballTeam';
import {
  botToken as configBotToken, inviteCode as configInviteCode, adminChatIds as configAdminChatIds, botAutoDescription,
  publicUrl as configPublicUrl,
} from '../config';
import { serviceLog } from './serviceLogger';
import { spieltagsGrussFaellig, textSpieltag } from './handballBotTexts';
import {
  DATUM, ZEIT, ankuendigungTastatur, berichtTastatur, botIdentity, datum, eigeneSeite, endstandTastatur, erinnerungTastatur, gegnerId,
  gegnerVon, halleAlsOrt, hilfeTastatur, icsKalender, knopf, modusTastatur, namenAus, routenTastatur, spielTastatur, spielerTastatur,
  spielerTreffer, statusTastatur, tabellenBewegung, teamsTastatur, textAenderung, textAnkuendigung, textAufstellung, textBericht,
  textEndstand, textErgebnisse, textHalbzeit, textKader, textLive, textRekorde, textSaison, textSpiele, textSpieler, textTabelle,
  textTeams,
} from './handballBotTexts';
import {
  type EndstandKarteExtras, bildKader, bildSaison, bildSpiel, bildSpieler, bildTabelle, bildTorjaeger, bildVerlauf, endstandAnimation,
  endstandBild, saisonName, wettbewerbVon,
} from './handballBotImages';
export * from './handballBotTexts';
export * from './handballBotImages';

/** Wie lange nach dem Anwurf `/live` ein angesetztes Spiel noch als laufend nimmt. */
const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Fenster, in dem nach der Aufstellung gesehen wird. */
const LINEUP_FROM_MS = -5 * 60 * 1000;
const LINEUP_UNTIL_MS = 30 * 60 * 1000;
/** Ein Endstand, der älter ist, gilt als Vergangenheit und wird nur gemerkt. */
const RESULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/**
 * Eine Wertung kommt Tage nach dem Spiel (die Spielleitung entscheidet über
 * Abbruch und Nichtantreten) — sie darf deshalb älter sein als ein Endstand.
 * Zwei Wochen: Beim ersten Lauf nach dem Einrichten kommen keine Wertungen
 * aus der Hinrunde.
 */
const RATED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Fenster für den Halbzeitstand: 2 × 25 Minuten Jugendspiel, die erste Hälfte
 * ist mit Unterbrechungen nach 27 bis 30 Minuten vorbei. Bei einem Takt von
 * 15 Minuten sind das zwei Blicke in die Torfolge; danach gibt der Bot auf.
 */
const HALFTIME_FROM_MS = 27 * 60 * 1000;
const HALFTIME_UNTIL_MS = 60 * 60 * 1000;
/**
 * Fenster für den Spielbericht: Die Quelle schreibt ihn irgendwann nach dem
 * Abpfiff (am 26.09.2026 stand er zwei Stunden nach Anwurf). Gesehen wird ab
 * 75 Minuten nach Anwurf je Takt, bis acht Stunden danach — höchstens 27
 * Blicke für ein Spiel am Samstagnachmittag.
 */
const REPORT_FROM_MS = 75 * 60 * 1000;
const REPORT_UNTIL_MS = 8 * 60 * 60 * 1000;
/** Eine Verlegung, die der Abruf vor mehr als einem Tag gesehen hat, wird nur gemerkt (erster Lauf mit Abonnenten). */
const CHANGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** So viel Abstand muss zwischen Spieltagsgruß und Ankündigung liegen, sonst entfällt der Gruß. */
const GRUSS_ABSTAND_ZUR_ANKUENDIGUNG_MS = 2 * 60 * 60 * 1000;

const BOT_COMMANDS: BotCommand[] = [
  { command: 'spiele', description: 'Die nächsten Spiele' },
  { command: 'ergebnisse', description: 'Die letzten Ergebnisse' },
  { command: 'tabelle', description: 'Die aktuelle Tabelle' },
  { command: 'kader', description: 'Der Kader mit Rückennummern' },
  { command: 'spieler', description: 'Die Bilanz eines Spielers, zum Antippen' },
  { command: 'torjaeger', description: 'Die Torjäger als Grafik' },
  { command: 'saison', description: 'Die Saisonbilanz mit Tabellenplatz-Verlauf' },
  { command: 'saisonkarte', description: 'Die Saisonbilanz als Karte' },
  { command: 'rekorde', description: 'Die Rekorde der Saison' },
  { command: 'bericht', description: 'Der Spielbericht zum letzten Spiel' },
  { command: 'live', description: 'Zwischenstand, wenn ein Spiel läuft' },
  { command: 'kalender', description: 'Alle Spiele als Kalenderdatei' },
  { command: 'halle', description: 'Die Halle des nächsten Spiels als Ort' },
  { command: 'teams', description: 'Welche Mannschaften du verfolgst' },
  { command: 'erinnerung', description: 'Wann vor dem Anwurf erinnern' },
  { command: 'modus', description: 'Alles oder nur Ergebnisse' },
  { command: 'feedback', description: 'Ein Wort an den Betreiber' },
  { command: 'hilfe', description: 'Was der Bot kann' },
  { command: 'stop', description: 'Keine Meldungen mehr' },
];

/**
 * Die Befehle des Betreibers — nur im Menü der Admin-Chats aus der
 * Dienste-Zeile (Chat-Scope, siehe `adminMenueSetzen`). Das Menü ist
 * Komfort: Berechtigt ist, wer in `bot_admin_chat_id` steht, geprüft bei
 * jedem Befehl (`istAdmin`), egal was im Menü steht.
 */
const ADMIN_COMMANDS: BotCommand[] = [
  { command: 'status', description: 'Betriebsstand (nur Betreiber)' },
  { command: 'rundruf', description: 'Nachricht an alle Abonnenten (nur Betreiber)' },
  { command: 'erledigt', description: 'Rückmeldung als erledigt markieren (nur Betreiber)' },
];

/**
 * Was der Webhook zustellt. `my_chat_member` für den Austritt aus Gruppen,
 * `inline_query` für den Inline-Modus — ohne beide in der Liste kämen sie
 * nie an (Telegram stellt nur zu, was hier steht).
 */
export const HANDBALL_ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member', 'inline_query'];

/** Vorlauf der Ankündigung je Chat — die Werte, die `/erinnerung` kennt. */
export const LEADS = ['1h', '3h', 'abend', 'aus'] as const;
export type Lead = typeof LEADS[number];
export type Mode = 'all' | 'results';
const DEFAULT_LEAD: Lead = '1h';

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

/**
 * Der Token kommt aus `TELEGRAM_BOT_TOKEN`, der Einladungscode aus
 * `TELEGRAM_INVITE_CODE`, die Admin-Chats aus `TELEGRAM_ADMIN_CHAT_IDS` —
 * alles ENV, siehe `config.ts`. In Todoteck stand der Token in der
 * Dienste-Zeile, samt einer Prüfung, für welche Instanz er gespeichert
 * wurde (ein eingespieltes Backup durfte den Prod-Bot nicht umbiegen).
 * Eine ENV wandert mit keinem Backup — die Prüfung ist hier gegenstandslos,
 * `botRegistrationState` sagt deshalb immer „für diese Instanz".
 */
export function getHandballBotToken(): string | null {
  return configBotToken();
}

export function isHandballBotEnabled(): boolean {
  return getHandballBotToken() !== null;
}

function inviteCode(): string | null {
  return configInviteCode();
}

/** Die Admin-Chats aus der Konfiguration — leer, wenn keiner eingetragen ist. */
export function adminChatIds(): Set<string> {
  return configAdminChatIds();
}

function istAdmin(chatId: string): boolean {
  return adminChatIds().has(chatId);
}

function publicUrl(): string {
  return configPublicUrl();
}

export interface HandballBotRegistrationState {
  source: 'env' | null;
  /** Ein Token aus der ENV gilt immer für diese Instanz. */
  registeredHere: boolean;
  /** Bleibt aus Todoteck-Zeiten: für welche Instanz ein gespeicherter Token galt — hier immer null. */
  storedFor: string | null;
}

export function botRegistrationState(): HandballBotRegistrationState {
  return getHandballBotToken() ? { source: 'env', registeredHere: true, storedFor: null } : { source: null, registeredHere: false, storedFor: null };
}

export interface HandballBotSecrets {
  webhookPathSecret: string;
  webhookHeaderSecret: string;
}

export function ensureHandballBotSecrets(): HandballBotSecrets {
  const existing = db.select().from(handball_bot_instance).where(eq(handball_bot_instance.id, 1)).get();
  if (existing) {
    return { webhookPathSecret: existing.webhook_path_secret, webhookHeaderSecret: existing.webhook_header_secret };
  }
  const row = {
    id: 1,
    webhook_path_secret: crypto.randomBytes(24).toString('base64url'),
    webhook_header_secret: crypto.randomBytes(32).toString('hex'),
    created_at: new Date().toISOString(),
  };
  db.insert(handball_bot_instance).values(row).run();
  return { webhookPathSecret: row.webhook_path_secret, webhookHeaderSecret: row.webhook_header_secret };
}

export function buildHandballWebhookUrl(pathSecret: string): string {
  return `${publicUrl()}/telegram/webhook/${pathSecret}`;
}


/**
 * Wie die letzte Webhook-Registrierung in diesem Prozess ausging — für die
 * Dienste-Zeile (`handball_bot`). `null` heißt: in diesem Prozess noch nicht
 * versucht (Start übersprungen, Token nie gespeichert).
 */
let webhookZustand: { ok: boolean; error: string | null; at: string } | null = null;

/** Nur für Tests und die Gesundheitsübersicht. */
export function getHandballWebhookState(): { ok: boolean; error: string | null; at: string } | null {
  return webhookZustand;
}

/** Webhook und Befehlsmenü registrieren, Bot-Namen merken. */
export async function registerHandballBot(): Promise<{ url: string; username: string | null }> {
  const token = getHandballBotToken();
  if (!token) throw new Error('Kein Bot-Token (TELEGRAM_BOT_TOKEN)');
  const secrets = ensureHandballBotSecrets();
  const url = buildHandballWebhookUrl(secrets.webhookPathSecret);
  try {
    await setWebhook(token, url, secrets.webhookHeaderSecret, HANDBALL_ALLOWED_UPDATES);
  } catch (err) {
    webhookZustand = { ok: false, error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() };
    throw err;
  }
  webhookZustand = { ok: true, error: null, at: new Date().toISOString() };
  // Frisch registriert: Eine alte Auskunft „zeigt woanders hin" gilt nicht mehr.
  webhookInfo = null;
  await setMyCommands(token, BOT_COMMANDS);
  try {
    const ich = await getMe(token);
    botIdentity.username = ich.username ?? null;
    inlineAn = typeof ich.supports_inline_queries === 'boolean' ? ich.supports_inline_queries : null;
  } catch {
    botIdentity.username = null;
    inlineAn = null;
  }
  await adminMenueSetzen(token);
  return { url, username: botIdentity.username };
}

/** Ob der Inline-Modus im BotFather eingeschaltet ist (`getMe`) — null: in diesem Prozess nicht erfragt. */
let inlineAn: boolean | null = null;

function instanzZeile() {
  ensureHandballBotSecrets();
  return db.select().from(handball_bot_instance).where(eq(handball_bot_instance.id, 1)).get();
}

/**
 * Das Befehlsmenü der Admin-Chats: je Chat die Standardbefehle **plus** die
 * des Betreibers, weil eine Liste mit Chat-Scope die Standardliste dort
 * ersetzt statt ergänzt. Wer aus der Dienste-Zeile verschwindet, bekommt
 * sein Menü per `deleteMyCommands` zurückgesetzt — dafür merkt sich die
 * Instanz-Zeile, wem sie eins gegeben hat. Scheitert das Aufräumen, bleibt
 * der Chat in der Liste und kommt beim nächsten Mal wieder dran.
 *
 * Fehler je Chat sind folgenlos (ein Chat, der nie mit dem Bot geredet hat,
 * ist für Telegram „chat not found"): Das Menü ist Komfort, die Berechtigung
 * prüft `istAdmin` bei jedem Befehl.
 */
async function adminMenueSetzen(token: string): Promise<void> {
  const jetzt = [...adminChatIds()];
  const zeile = instanzZeile();
  const vorher = (zeile?.admin_menu_chats ?? '').split(',').map(t => t.trim()).filter(Boolean);
  const behalten = new Set<string>();
  for (const chatId of jetzt) {
    try {
      await setMyCommands(token, [...BOT_COMMANDS, ...ADMIN_COMMANDS], { type: 'chat', chat_id: chatId });
      behalten.add(chatId);
    } catch (err) {
      serviceLog.warn({ chat: chatId, err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Admin-Menü nicht gesetzt');
    }
  }
  for (const chatId of vorher) {
    if (jetzt.includes(chatId)) continue;
    try {
      await deleteMyCommands(token, { type: 'chat', chat_id: chatId });
    } catch (err) {
      behalten.add(chatId);
      serviceLog.warn({ chat: chatId, err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Admin-Menü nicht entfernt');
    }
  }
  db.update(handball_bot_instance).set({ admin_menu_chats: [...behalten].join(',') || null }).where(eq(handball_bot_instance.id, 1)).run();
}

/** Das Admin-Menü neu setzen — nach einer Änderung der Admin-Chats. */
export async function refreshHandballAdminMenu(): Promise<void> {
  const token = getHandballBotToken();
  if (!token) return;
  await adminMenueSetzen(token);
}

/**
 * Webhook und Menü registrieren, die gemerkten Beschreibungen vergessen —
 * ein neuer Token kann ein anderer Bot sein, dessen Beschreibung der nächste
 * Lauf neu setzt statt „unverändert" anzunehmen. Ohne Token passiert nichts.
 */
export async function activateHandballBot(): Promise<{ url: string; username: string | null } | null> {
  if (!getHandballBotToken()) return null;
  ensureHandballBotSecrets();
  db.update(handball_bot_instance).set({ description_text: null, short_description_text: null }).where(eq(handball_bot_instance.id, 1)).run();
  return registerHandballBot();
}

/** Beim Serverstart — mit der Instanz-Prüfung aus `botRegistrationState`. */
export async function registerHandballBotAtBoot(): Promise<
  | { status: 'registered'; url: string; username: string | null }
  | { status: 'skipped'; reason: string }
> {
  const state = botRegistrationState();
  if (state.source === null) return { status: 'skipped', reason: 'kein Bot-Token (TELEGRAM_BOT_TOKEN)' };
  if (!state.registeredHere) return { status: 'skipped', reason: 'Token nicht für diese Instanz' };
  const r = await registerHandballBot();
  return { status: 'registered', ...r };
}

export function getHandballBotUsername(): string | null {
  return botIdentity.username;
}

/**
 * Der Link, mit dem jemand den Bot abonniert — `t.me/<bot>`, mit dem
 * Einladungscode als `?start=<code>`, wenn einer gesetzt ist (ohne ihn
 * antwortet `/start` „nicht öffentlich"). Null, solange der Bot nicht
 * registriert ist: Der Benutzername kommt erst von `getMe`, und ein Link
 * auf einen unbekannten Bot wäre ein toter Knopf auf der Microsite.
 *
 * Der Code steht damit auf einer Seite, die jeder öffnen kann, dem man den
 * Link gab — das ist gewollt: Die Microsite ist selbst die Einladung
 * (Wiki „Handball-Verfolgung (handball.net)“ §7.2), und wer sie hat, darf auch den Bot.
 */
export function handballBotLink(): string | null {
  if (!botIdentity.username) return null;
  const code = inviteCode();
  return `https://t.me/${botIdentity.username}${code ? `?start=${encodeURIComponent(code)}` : ''}`;
}

// ---------------------------------------------------------------------------
// Abonnenten
// ---------------------------------------------------------------------------

export interface HandballSubscriber {
  chatId: string;
  name: string | null;
  lead: Lead;
  mode: Mode;
  /**
   * Die verfolgten Mannschaften (`/teams`); null heißt alle, eine leere Liste
   * noch keine — so steht ein neuer Chat da, bis er gewählt hat.
   */
  teamIds: string[] | null;
}

function alsLead(v: string | null): Lead {
  return (LEADS as readonly string[]).includes(v ?? '') ? (v as Lead) : DEFAULT_LEAD;
}

export function listSubscribers(): HandballSubscriber[] {
  return db.select().from(handball_bot_subscriber).all().map(r => ({
    chatId: r.chat_id, name: r.name, lead: alsLead(r.lead), mode: r.mode === 'results' ? 'results' as const : 'all' as const,
    teamIds: alsTeamIds(r.team_ids),
  }));
}

function alsTeamIds(roh: string | null): string[] | null {
  // Leerer Text (nicht NULL) ist die bewusst leere Auswahl eines neuen Chats.
  if (roh === '') return [];
  const ids = (roh ?? '').split(',').map(t => t.trim()).filter(t => /^\d{1,12}$/.test(t));
  return ids.length > 0 ? ids : null;
}

function setTeams(chatId: string, teamIds: string[] | null): void {
  db.update(handball_bot_subscriber).set({ team_ids: teamIds ? teamIds.join(',') : null }).where(eq(handball_bot_subscriber.chat_id, chatId)).run();
}

/** Ob ein Abonnent diese Mannschaft verfolgt — ohne Auswahl (null) alle, mit leerer keine. */
export function verfolgt(abo: Pick<HandballSubscriber, 'teamIds'>, teamId: string): boolean {
  return !abo.teamIds || abo.teamIds.includes(teamId);
}

/**
 * Die Mannschaften, die ein Chat sehen will — seine Auswahl aus `/teams`,
 * ohne Auswahl alle. Eine Auswahl, die keine eingetragene Mannschaft mehr
 * trifft (ID aus der Konfiguration genommen), zählt wie keine.
 */
export function meineTeams(chatId: string, teams: HandballTeamView[]): HandballTeamView[] {
  const abo = abonnent(chatId);
  if (!abo?.teamIds) return teams;
  const eigene = teams.filter(t => abo.teamIds!.includes(t.team_id));
  return eigene.length > 0 ? eigene : teams;
}

function setLead(chatId: string, lead: Lead): void {
  db.update(handball_bot_subscriber).set({ lead }).where(eq(handball_bot_subscriber.chat_id, chatId)).run();
}

function setMode(chatId: string, mode: Mode): void {
  db.update(handball_bot_subscriber).set({ mode }).where(eq(handball_bot_subscriber.chat_id, chatId)).run();
}

function abonnent(chatId: string): HandballSubscriber | null {
  return listSubscribers().find(s => s.chatId === chatId) ?? null;
}

function subscribe(chatId: string, name: string | null): boolean {
  const now = new Date().toISOString();
  const existing = db.select().from(handball_bot_subscriber).where(eq(handball_bot_subscriber.chat_id, chatId)).get();
  if (existing) {
    db.update(handball_bot_subscriber).set({ name, last_seen_at: now }).where(eq(handball_bot_subscriber.chat_id, chatId)).run();
    return false;
  }
  db.insert(handball_bot_subscriber).values({ chat_id: chatId, name, subscribed_at: now, last_seen_at: now }).run();
  return true;
}

function unsubscribe(chatId: string): boolean {
  const r = db.delete(handball_bot_subscriber).where(eq(handball_bot_subscriber.chat_id, chatId)).run();
  return r.changes > 0;
}

function touch(chatId: string): void {
  db.update(handball_bot_subscriber).set({ last_seen_at: new Date().toISOString() })
    .where(eq(handball_bot_subscriber.chat_id, chatId)).run();
}

function istAbonnent(chatId: string): boolean {
  return !!db.select().from(handball_bot_subscriber).where(eq(handball_bot_subscriber.chat_id, chatId)).get();
}


/**
 * Die Tabelle als Bild — am Telefon bleibt sie so eine Tabelle, als
 * Festbreitentext bricht Telegram sie um. Schlägt Rendern oder Senden fehl,
 * kommt die Textfassung; ein Befehl ohne Antwort wäre der schlechtere Fall.
 */

async function tabelleSenden(chatId: string, team: HandballTeamView, s: HandballStandingsView, deps: HandballBotDeps): Promise<void> {
  if (deps.sendPhoto) {
    zeigeAktivitaet(chatId, 'upload_photo', deps);
    try {
      const png = await renderPng(bildTabelle(team, s));
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
      const png = await renderPng(svg);
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
      const png = await renderPng(svg());
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
    pngs = await Promise.all(teile.map(t => renderPng(t.svg)));
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
  if (deps.sendPhoto && team && m && m.status !== 'live') {
    zeigeAktivitaet(chatId, 'upload_photo', deps);
    try {
      const png = await renderPng(await bildSpiel(m));
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
// Webhook bei Telegram nachsehen (getWebhookInfo)
// ---------------------------------------------------------------------------

/** Wie alt die Auskunft von Telegram höchstens sein darf, bevor sie neu geholt wird. */
const WEBHOOK_INFO_MAX_ALTER_MS = 10 * 60 * 1000;
/** Ab so vielen wartenden Updates ist der Bot gelb — Telegram kommt nicht durch. */
const WEBHOOK_STAU = 50;

let webhookInfo: { at: number; info: TelegramWebhookInfo | null; fehler: string | null } | null = null;
let webhookInfoLaeuft: Promise<void> | null = null;

/**
 * `getWebhookInfo` höchstens alle zehn Minuten, im Prozess vorgehalten und
 * von gleichzeitigen Aufrufern geteilt. Aufgerufen nach jedem Abruf-Takt
 * (damit die Auskunft meist schon da ist), vor `/status` und vor der
 * Dienste-Zeile. Ein Fehlschlag der Abfrage selbst heißt „unbekannt" — nie
 * rot allein deshalb.
 */
export async function refreshHandballWebhookInfo(now = Date.now()): Promise<void> {
  const token = getHandballBotToken();
  if (!token || !botRegistrationState().registeredHere) return;
  if (webhookInfo && now - webhookInfo.at < WEBHOOK_INFO_MAX_ALTER_MS) return;
  if (webhookInfoLaeuft) return webhookInfoLaeuft;
  webhookInfoLaeuft = (async () => {
    try {
      webhookInfo = { at: now, info: await getWebhookInfo(token), fehler: null };
    } catch (err) {
      webhookInfo = { at: now, info: null, fehler: err instanceof Error ? err.message : String(err) };
    } finally {
      webhookInfoLaeuft = null;
    }
  })();
  return webhookInfoLaeuft;
}

export interface HandballWebhookBefund {
  /** Rot: Telegram stellt nicht an diese Instanz zu. */
  rot: string | null;
  /** Gelb: Zustellfehler in den letzten 24 Stunden oder ein Stau. */
  gelb: string | null;
  /** Kurzform für `/status`. */
  zeile: string;
}

/** Was die vorgehaltene Auskunft von Telegram sagt — ohne eigenen Aufruf. */
export function handballWebhookBefund(now = Date.now()): HandballWebhookBefund {
  if (!webhookInfo) return { rot: null, gelb: null, zeile: 'noch nicht nachgesehen' };
  if (!webhookInfo.info) return { rot: null, gelb: null, zeile: `unbekannt (${webhookInfo.fehler ?? 'keine Antwort'})` };
  const info = webhookInfo.info;
  const erwartet = buildHandballWebhookUrl(ensureHandballBotSecrets().webhookPathSecret);
  if (!info.url) {
    return { rot: 'Telegram kennt keinen Webhook für diesen Bot — Dienst neu starten.', gelb: null, zeile: 'kein Webhook eingetragen' };
  }
  if (info.url !== erwartet) {
    let host = 'eine andere Adresse';
    try { host = new URL(info.url).host; } catch { /* bleibt allgemein */ }
    return {
      rot: `Der Webhook zeigt auf ${host}, nicht auf diese Instanz — ein anderer Server hat denselben Token registriert. Hier neu speichern holt ihn zurück.`,
      gelb: null,
      zeile: `zeigt auf ${host}`,
    };
  }
  const warnungen: string[] = [];
  if (info.last_error_date && now - info.last_error_date * 1000 < 24 * 60 * 60 * 1000) {
    warnungen.push(`Telegram meldet einen Zustellfehler (${ZEIT.format(new Date(info.last_error_date * 1000))} Uhr): ${info.last_error_message ?? 'ohne Text'}`);
  }
  if (info.pending_update_count > WEBHOOK_STAU) warnungen.push(`${info.pending_update_count} Updates warten bei Telegram`);
  const gelb = warnungen.length > 0 ? warnungen.join(' · ') : null;
  return { rot: null, gelb, zeile: gelb ? `stimmt, aber: ${gelb}` : 'stimmt' };
}

export interface HandballBotHealth {
  configured: boolean;
  /** Rot: Webhook fehlt oder alle Zustellungen der letzten 24 Stunden scheiterten. */
  error: string | null;
  /** Gelb: mehr als 10 % der Zustellungen der letzten 7 Tage gescheitert — die Zahl der gescheiterten. */
  failed7d: number;
  delivered7d: number;
  /** Jüngste gelungene Zustellung. */
  lastOk: string | null;
  detail: string | null;
}

/** Ab diesem Anteil gescheiterter Zustellungen in sieben Tagen ist der Bot gelb. */
const BOT_WARN_ANTEIL = 0.1;

/**
 * Die Dienste-Zeile des Bots (`handball_bot` in `GET /sync/health`):
 * - nicht eingerichtet ohne Token;
 * - rot, wenn der Webhook für diese Instanz nicht registriert ist oder die
 *   letzte Registrierung scheiterte, oder wenn **jede** Zustellung der
 *   letzten 24 Stunden scheiterte (mindestens eine);
 * - gelb, wenn in sieben Tagen mehr als 10 % der Zustellungen scheiterten;
 * - seit 27.09.2026 dazu, was Telegram über den Webhook sagt
 *   (`handballWebhookBefund`): rot, wenn er leer ist oder auf eine andere
 *   Adresse zeigt; gelb bei einem Zustellfehler in 24 Stunden oder einem
 *   Stau — der gelbe Text steht in `detail`;
 * - sonst grün.
 * Liest nur Datenbank und Prozesszustand; die Auskunft von Telegram holt
 * vorher `refreshHandballWebhookInfo` (höchstens alle zehn Minuten).
 */
export function getHandballBotHealth(now = new Date()): HandballBotHealth {
  if (!isHandballBotEnabled()) return { configured: false, error: null, failed7d: 0, delivered7d: 0, lastOk: null, detail: null };
  const tag = 24 * 60 * 60 * 1000;
  const zeilen = db.select().from(handball_bot_delivery)
    .where(gte(handball_bot_delivery.sent_at, new Date(now.getTime() - 7 * tag).toISOString())).all();
  const ok7 = zeilen.filter(z => z.ok === 1).length;
  const fehl7 = zeilen.length - ok7;
  const letzte24 = zeilen.filter(z => z.sent_at >= new Date(now.getTime() - tag).toISOString());
  const lastOk = zeilen.filter(z => z.ok === 1).map(z => z.sent_at).sort().at(-1) ?? null;
  const state = botRegistrationState();
  let error: string | null = null;
  if (!state.registeredHere) {
    error = 'Webhook nicht für diese Instanz registriert.';
  } else if (webhookZustand && !webhookZustand.ok) {
    error = `Webhook-Registrierung gescheitert: ${webhookZustand.error ?? 'unbekannt'}`;
  } else if (letzte24.length > 0 && letzte24.every(z => z.ok === 0)) {
    error = `Alle ${letzte24.length} Zustellungen der letzten 24 Stunden gescheitert: ${letzte24.map(z => z.detail).filter(Boolean).at(-1) ?? 'unbekannt'}`;
  }
  const befund = state.registeredHere ? handballWebhookBefund(now.getTime()) : null;
  if (!error && befund?.rot) error = befund.rot;
  const warn = zeilen.length > 0 && fehl7 / zeilen.length > BOT_WARN_ANTEIL;
  const gelb = befund?.gelb ?? null;
  return {
    configured: true,
    error,
    // Die Karte kennt Gelb nur als Zahl ohne Text — der Text steht in `detail`.
    failed7d: warn ? fehl7 : gelb ? 1 : 0,
    delivered7d: ok7,
    lastOk,
    detail: `${listSubscribers().length} Abonnent(en) · ${ok7} Zustellungen in 7 Tagen${fehl7 ? `, ${fehl7} gescheitert` : ''}${gelb ? ` · Webhook: ${gelb}` : ''}`,
  };
}

function offeneRueckmeldungen() {
  return db.select().from(handball_bot_feedback).where(isNull(handball_bot_feedback.done_at)).all()
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Gelungen und gescheitert in den letzten 7 und 28 Tagen, dazu je Chat der jüngste Fehlschlag. */
function zustellBilanz(now: Date) {
  const tag = 24 * 60 * 60 * 1000;
  const seitMonat = new Date(now.getTime() - 28 * tag).toISOString();
  const seitWoche = new Date(now.getTime() - 7 * tag).toISOString();
  const zeilen = db.select().from(handball_bot_delivery).where(gte(handball_bot_delivery.sent_at, seitMonat)).all();
  const zaehle = (ab: string) => {
    const teil = zeilen.filter(z => z.sent_at >= ab);
    return { ok: teil.filter(z => z.ok === 1).length, fehl: teil.filter(z => z.ok === 0).length };
  };
  const juengste = new Map<string, { chatId: string; detail: string | null; sentAt: string }>();
  for (const z of zeilen) {
    if (z.ok === 1) continue;
    const bisher = juengste.get(z.chat_id);
    if (!bisher || z.sent_at > bisher.sentAt) juengste.set(z.chat_id, { chatId: z.chat_id, detail: z.detail, sentAt: z.sent_at });
  }
  return { woche: zaehle(seitWoche), monat: zaehle(seitMonat), gescheitert: [...juengste.values()].sort((a, b) => b.sentAt.localeCompare(a.sentAt)) };
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

async function defaultSendPhoto(chatId: string, png: Buffer, caption: string, filename = 'bild.png', keyboard: InlineKeyboard | null = null, extras: SendExtras = {}): Promise<number | void> {
  const token = getHandballBotToken();
  if (!token) return;
  const msg = await sendPhotoBytes(token, { chatId, data: png, filename, contentType: 'image/png', caption, keyboard, messageEffectId: extras.effectId });
  return msg?.message_id;
}

async function defaultSendAnimation(chatId: string, gif: Buffer, caption: string, filename = 'bild.gif', keyboard: InlineKeyboard | null = null, extras: SendExtras = {}): Promise<number | void> {
  const token = getHandballBotToken();
  if (!token) return;
  const msg = await sendAnimationBytes(token, { chatId, data: gif, filename, contentType: 'image/gif', caption, keyboard, messageEffectId: extras.effectId });
  return msg?.message_id;
}

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

const DEFAULT_DEPS: HandballBotDeps = {
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

/** Nur für Tests. */
export function __resetHandballBotForTests(): void {
  gesehen.clear();
  botIdentity.username = null;
  webhookZustand = null;
  inlineAn = null;
  webhookInfo = null;
  webhookInfoLaeuft = null;
}

async function antwortAufBefehl(text: string, chatId: string, name: string | null, deps: HandballBotDeps): Promise<void> {
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
    db.insert(handball_bot_feedback).values({ chat_id: chatId, name, text: argument, created_at: new Date().toISOString() }).run();
    for (const admin of adminChatIds()) {
      try { await deps.send(admin, `💬 <b>Feedback</b> von ${escapeHtml(name ?? chatId)} (Chat <code>${escapeHtml(chatId)}</code>):\n${escapeHtml(argument)}`); } catch { /* der Betreiber ist nicht erreichbar — der Eintrag steht in der Datenbank */ }
    }
    await deps.send(chatId, 'Danke, ist angekommen.');
    return;
  }
  if (befehl === '/status') {
    if (!istAdmin(chatId)) {
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
    if (!istAdmin(chatId)) { await deps.send(chatId, 'Das darf nur der Betreiber.'); return; }
    const id = Number.parseInt(argument, 10);
    const zeile = Number.isFinite(id) ? db.select().from(handball_bot_feedback).where(eq(handball_bot_feedback.id, id)).get() : undefined;
    if (!zeile) { await deps.send(chatId, 'Welche Rückmeldung? /erledigt 12 — die Nummern stehen unter /status.'); return; }
    if (!zeile.done_at) db.update(handball_bot_feedback).set({ done_at: new Date().toISOString() }).where(eq(handball_bot_feedback.id, id)).run();
    const offen = offeneRueckmeldungen().length;
    await deps.send(chatId, `Rückmeldung #${id} erledigt${offen ? ` — ${offen} noch offen` : ' — keine mehr offen'}.`, statusTastatur(offeneRueckmeldungen()));
    return;
  }
  if (befehl === '/rundruf') {
    if (!istAdmin(chatId)) { await deps.send(chatId, 'Das darf nur der Betreiber.'); return; }
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
      await antwortAufBefehl(`/${m[1]}${m[2] ? ` ${m[2]}` : ''}`, chatId, name, deps);
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
      await antwortAufBefehl(text, chatId, name, deps);
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
    case 'spiel': return !!team.next_match && team.next_match.status !== 'live';
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
    const eigene = m.is_home ? m.score_home : m.score_away;
    const andere = m.is_home ? m.score_away : m.score_home;
    const zeile = `${eigene}:${andere} ${m.is_home ? 'gegen' : 'bei'} ${gegnerVon(m)}`;
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
    inlineAn = typeof ich.supports_inline_queries === 'boolean' ? ich.supports_inline_queries : null;
  } catch { /* bleibt „unbekannt" */ }
}

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
    const liga = [wettbewerbVon(team), saisonName(team.matches[0]?.season_id)].filter(Boolean).join(', Saison ');
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

// ---------------------------------------------------------------------------
// Meldungen von sich aus
// ---------------------------------------------------------------------------

function schonGeschickt(id: string): boolean {
  return !!db.select().from(handball_bot_sent).where(eq(handball_bot_sent.id, id)).get();
}

function merke(id: string): void {
  db.insert(handball_bot_sent).values({ id, sent_at: new Date().toISOString() }).onConflictDoNothing().run();
}

/**
 * An alle Abonnenten. Wer den Bot blockiert hat (403), fliegt aus der Liste —
 * sonst kostet jede Meldung einen Fehlversuch mehr, für immer.
 */
type Empfaenger = (abo: HandballSubscriber) => boolean;
/** Alle; und nur die, die alles wollen — Ankündigung, Aufstellung und Halbzeit gehen nicht an „nur Ergebnisse". */
const ALLE: Empfaenger = () => true;
const NUR_ALLES: Empfaenger = abo => abo.mode === 'all';
/** Dazu die Auswahl aus `/teams`: eine Meldung zu einer Mannschaft geht nur an die, die sie verfolgen. */
const fuerTeam = (teamId: string, wer: Empfaenger): Empfaenger => abo => wer(abo) && verfolgt(abo, teamId);

/** Was der Bot von sich aus schickt — der Schlüssel im Zustell-Protokoll. */
type Meldungsart = 'ankuendigung' | 'aufstellung' | 'halbzeit' | 'endstand' | 'bericht' | 'aenderung' | 'rundruf' | 'saison';

/** Aufbewahrung des Zustell-Protokolls. */
const DELIVERY_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Eine Zustellung protokollieren, gelungen oder nicht — `/status` zählt
 * daraus. Bei einem Fehlschlag die Telegram-Meldung, gekürzt.
 */
function protokolliere(chatId: string, art: Meldungsart, ok: boolean, err?: unknown): void {
  const detail = ok ? null : (err instanceof Error ? err.message : String(err)).slice(0, 160);
  db.insert(handball_bot_delivery).values({ chat_id: chatId, kind: art, ok: ok ? 1 : 0, detail, sent_at: new Date().toISOString() }).run();
}

function protokollAufraeumen(now: Date): void {
  db.delete(handball_bot_delivery).where(lt(handball_bot_delivery.sent_at, new Date(now.getTime() - DELIVERY_KEEP_MS).toISOString())).run();
}

async function rundsenden(text: string, deps: HandballBotDeps, keyboard: InlineKeyboard | null, wer: Empfaenger, art: Meldungsart): Promise<number> {
  return (await anAlle(chatId => deps.send(chatId, text, keyboard), wer, art)).count;
}

/**
 * Ein Bild an alle, mit dem Text als Unterschrift — passt er nicht in eine,
 * folgt er als Nachricht. Scheitert das Bild, kommt der Text allein: Ein
 * Endstand ohne Bild ist besser als keiner.
 */
async function rundsendenBild(png: Buffer, text: string, filename: string, deps: HandballBotDeps, keyboard: InlineKeyboard | null, wer: Empfaenger, art: Meldungsart, gif: Buffer | null = null, effekt: string | null = null): Promise<Zustellung> {
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
async function mitEffekt<T>(chatId: string, effekt: string | null, sende: (extras?: SendExtras) => Promise<T>): Promise<T> {
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

interface Zustellung {
  count: number;
  /** Chat und Nachrichten-ID je gelungener Zustellung — für die Reaktion auf den Sieg. */
  sent: Array<{ chatId: string; messageId: number }>;
}

/**
 * Eine gescheiterte Zustellung einordnen. 403: blockiert (Privatchat) oder
 * rausgeworfen (Gruppe). 400 „chat not found": die Gruppe ist gelöscht oder
 * zur Supergruppe geworden — dann kommt sie mit neuer ID wieder, wenn dort
 * jemand /start schickt. Beides trägt aus, sonst kostet jede Meldung für
 * immer einen Fehlversuch mehr.
 */
function zustellungGescheitert(chatId: string, err: unknown): void {
  const weg = err instanceof TelegramApiError
    && (err.status === 403 || (err.status === 400 && CHAT_WEG.test(err.message)));
  if (weg) {
    unsubscribe(chatId);
    serviceLog.info({ chat: chatId }, '[handball-bot] Chat nicht mehr erreichbar (blockiert oder entfernt) — ausgetragen');
    return;
  }
  serviceLog.warn({ chat: chatId, err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Zustellung fehlgeschlagen');
}

async function anAlle(sende: (chatId: string) => Promise<number | void>, wer: Empfaenger, art: Meldungsart): Promise<Zustellung> {
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

export interface HandballBotPushResult {
  messages: number;
  recipients: number;
  /** Aufrufe nach handball.net aus dem Bot heraus: Aufstellung, Torfolge, Spielbericht, Gegner-Spielplan. */
  fetches: number;
}

/**
 * Die fälligen Meldungen — ein Takt des Jobs, **nach** dem Abruf. Liest die
 * Sicht aus der Datenbank; nach draußen geht nur der Aufstellungs-Abruf im
 * engen Fenster um den Anwurf und einmal für die Torschützen nach dem Spiel.
 */
export async function pushHandballBot(now = new Date(), deps: HandballBotDeps = DEFAULT_DEPS): Promise<HandballBotPushResult> {
  const out: HandballBotPushResult = { messages: 0, recipients: 0, fetches: 0 };
  if (!isHandballBotEnabled() && deps === DEFAULT_DEPS) return out;
  if (listSubscribers().length === 0) return out;
  const sicht = handballOverview();
  if (!sicht.configured) return out;
  const jetzt = now.getTime();
  protokollAufraeumen(now);

  for (const team of sicht.teams) {
    // --- Verlegungen und Absagen ---
    // Was der Abruf an einem gespeicherten Spiel geändert hat. Älter als ein
    // Tag wird nur gemerkt: Der erste Lauf mit Abonnenten soll nicht die
    // Verlegungen der ganzen Vorrunde nachliefern.
    for (const c of changesFor(team.team_id)) {
      const key = `${team.team_id}:${c.match_id}:change:${c.change_id}`;
      if (schonGeschickt(key)) continue;
      merke(key);
      if (jetzt - Date.parse(c.detected_at) > CHANGE_MAX_AGE_MS) continue;
      const m = team.matches.find(x => x.match_id === c.match_id);
      if (!m) continue;
      const n = await rundsenden(textAenderung(team, m, c), deps, c.kind === 'rescheduled' ? routenTastatur(m) : null, fuerTeam(team.team_id, ALLE), 'aenderung');
      out.messages++; out.recipients += n;
    }

    for (const m of team.matches) {
      const start = Date.parse(m.starts_at);
      const schluessel = (art: string) => `${team.team_id}:${m.match_id}:${art}`;

      // --- Ankündigung — je Chat zu seiner Zeit (`/erinnerung`) ---
      if (m.status === 'scheduled' && start > jetzt) {
        let gegnerSpiele: HandballMatch[] | null | undefined;
        let text: string | null = null;
        let n = 0;
        for (const abo of listSubscribers()) {
          if (abo.mode !== 'all' || !verfolgt(abo, team.team_id)) continue;
          const ab = ankuendigungFaelligAb(m.starts_at, abo.lead);
          if (ab === null || jetzt < ab) continue;
          // Einmal je Chat und Spiel — auch wenn der Vorlauf später geändert wird.
          const key = schluessel(`upcoming:${abo.chatId}`);
          if (schonGeschickt(key)) continue;
          if (text === null) {
            // Die letzten drei Ergebnisse des Gegners stehen nicht in der eigenen
            // Datenbank — ein Abruf seines Spielplans, einmal je Spiel, nach bestem Bemühen.
            if (gegnerSpiele === undefined) {
              try {
                gegnerSpiele = await fetchTeamMatches(gegnerId(m), m.season_id);
                out.fetches++;
              } catch (err) {
                // Der Tageslauf hat ihn vielleicht schon — dann lieber der von heute Morgen als keiner.
                gegnerSpiele = opponentFormFor(gegnerId(m))?.matches ?? null;
                serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Spielplan des Gegners nicht abrufbar');
              }
            }
            text = textAnkuendigung(team, m, now, gegnerSpiele);
          }
          merke(key);
          try {
            await deps.send(abo.chatId, text, ankuendigungTastatur(m));
            n++;
            protokolliere(abo.chatId, 'ankuendigung', true);
          } catch (err) {
            protokolliere(abo.chatId, 'ankuendigung', false, err);
            zustellungGescheitert(abo.chatId, err);
            continue;
          }
          // Direkt darunter die Halle als Ort — still, weil die Ankündigung
          // schon geklingelt hat. Nach bestem Bemühen: Die Ankündigung steht.
          const ort = halleAlsOrt(m);
          if (ort && deps.sendVenue) {
            try { await deps.sendVenue(abo.chatId, ort); } catch (err) {
              serviceLog.warn({ chat: abo.chatId, err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Halle als Ort nicht zustellbar');
            }
          }
        }
        if (n > 0) { out.messages++; out.recipients += n; }
      }

      // --- Spieltagsgruß — am Morgen eines Spieltags, einmal je Chat und Spiel ---
      // Nur, wer Ankündigungen will (nicht „keine") und alles; wer die Ankündigung
      // dieses Spiels schon bekommen hat (Vorabend, drei Stunden), braucht keinen Gruß.
      if (m.status === 'scheduled' && start > jetzt && spieltagsGrussFaellig(m, now)) {
        const text = textSpieltag(team, m, opponentFormFor(gegnerId(m))?.matches ?? null);
        let n = 0;
        for (const abo of listSubscribers()) {
          if (abo.mode !== 'all' || abo.lead === 'aus' || !verfolgt(abo, team.team_id)) continue;
          const key = schluessel(`morning:${abo.chatId}`);
          if (schonGeschickt(key) || schonGeschickt(schluessel(`upcoming:${abo.chatId}`))) continue;
          // Kommt die Ankündigung ohnehin in den nächsten zwei Stunden, wäre der Gruß ein Doppel.
          const ankuendigungAb = ankuendigungFaelligAb(m.starts_at, abo.lead);
          if (ankuendigungAb !== null && ankuendigungAb - jetzt < GRUSS_ABSTAND_ZUR_ANKUENDIGUNG_MS) continue;
          merke(key);
          try {
            await deps.send(abo.chatId, text, routenTastatur(m));
            n++;
            protokolliere(abo.chatId, 'ankuendigung', true);
          } catch (err) {
            protokolliere(abo.chatId, 'ankuendigung', false, err);
            zustellungGescheitert(abo.chatId, err);
          }
        }
        if (n > 0) { out.messages++; out.recipients += n; }
      }

      // --- Aufstellung ---
      const imFenster = jetzt - start >= LINEUP_FROM_MS && jetzt - start <= LINEUP_UNTIL_MS;
      if ((m.status === 'scheduled' || m.status === 'live') && imFenster && !schonGeschickt(schluessel('lineup'))) {
        try {
          const lineup = await fetchLineups(m.match_id);
          out.fetches++;
          const seite = eigeneSeite(lineup, team.team_id);
          if (seite && seite.players.length > 0) {
            merke(schluessel('lineup'));
            const n = await rundsenden(textAufstellung(team, m, seite), deps, null, fuerTeam(team.team_id, NUR_ALLES), 'aufstellung');
            out.messages++; out.recipients += n;
          }
        } catch (err) {
          // Nach bestem Bemühen: Ohne Aufstellung kommt der Endstand trotzdem.
          serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Aufstellung nicht abrufbar');
        }
      } else if (jetzt - start > LINEUP_UNTIL_MS && !schonGeschickt(schluessel('lineup'))) {
        // Fenster vorbei, nie gekommen — nicht ewig nachsehen.
        merke(schluessel('lineup'));
      }

      // --- Halbzeit ---
      const imHalbzeitFenster = jetzt - start >= HALFTIME_FROM_MS && jetzt - start <= HALFTIME_UNTIL_MS;
      if ((m.status === 'scheduled' || m.status === 'live') && imHalbzeitFenster && !schonGeschickt(schluessel('halftime'))) {
        try {
          const events = await fetchMatchEvents(m.match_id);
          out.fetches++;
          // Nebenbei für den Zeitzonen-Selbsttest: Wo lag der Anwurf, gemessen an der Spieluhr?
          merkeAnwurfSchaetzung(team.team_id, m.match_id, events, now);
          if (events.halftime) {
            merke(schluessel('halftime'));
            setzeHalbzeit(team.team_id, m.match_id, events.halftime.home, events.halftime.away);
            const n = await rundsenden(textHalbzeit(team, m, events.halftime), deps, halbzeitTastatur(), fuerTeam(team.team_id, NUR_ALLES), 'halbzeit');
            out.messages++; out.recipients += n;
          }
        } catch (err) {
          serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Torfolge nicht abrufbar');
        }
      } else if (jetzt - start > HALFTIME_UNTIL_MS && !schonGeschickt(schluessel('halftime'))) {
        merke(schluessel('halftime'));
      }

      // --- Endstand ---
      const mitStand = m.score_home !== null && m.score_away !== null;
      if (((m.status === 'finished' && mitStand) || m.rated) && !schonGeschickt(schluessel('result'))) {
        merke(schluessel('result'));
        // Gewertet ohne Stand (nur die Tabelle zählt es): ein Satz, keine Karte.
        if (m.rated && !mitStand) {
          if (jetzt - start > RATED_MAX_AGE_MS) continue;
          const n = await rundsenden(textEndstand(team, m, null), deps, endstandTastatur(m), fuerTeam(team.team_id, ALLE), 'endstand');
          out.messages++; out.recipients += n;
          continue;
        }
        // Nur, was frisch ist: Beim ersten Lauf nach dem Einrichten (oder nach
        // einem langen Ausfall) sollen nicht alle Endstände der Saison auf
        // einmal kommen. Der Job fasst bis sechs Stunden nach Anwurf nach —
        // was später erst als beendet auftaucht, ist Vergangenheit.
        if (jetzt - start > (m.rated ? RATED_MAX_AGE_MS : RESULT_MAX_AGE_MS)) continue;
        let seite: HandballLineupSide | null = null;
        // Die Bilanz **vor** diesem Spiel — für „erstes Saisontor" — muss vor dem Ablegen der Aufstellung gelesen werden.
        const vorher = playerStats(team.team_id, { excludeMatchId: m.match_id });
        try {
          seite = eigeneSeite(await fetchLineups(m.match_id), team.team_id);
          out.fetches++;
          if (seite) storeLineup(team.team_id, m.match_id, seite);
        } catch { /* Torschützen sind Beiwerk */ }
        const text = textEndstand(team, m, seite, namenAus(team.team_id), { vorher, bewegung: tabellenBewegung(team) });
        const bester = (seite?.players ?? []).filter(p => p.goals > 0).sort((a, b) => b.goals - a.goals || a.number - b.number)[0];
        const extras: EndstandKarteExtras = {
          playerOfMatch: bester ? `${namenAus(team.team_id)(bester.playerId) ?? `Nr. ${bester.number}`} · ${bester.goals} Tor${bester.goals === 1 ? '' : 'e'}` : null,
        };
        let png: Buffer | null = null;
        let gif: Buffer | null = null;
        if (deps.sendPhoto) {
          try {
            png = await renderPng(await endstandBild(team, m, extras));
          } catch (err) {
            serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Endstand als Bild fehlgeschlagen — Textfassung');
          }
          if (png && deps.sendAnimation) {
            try {
              gif = await endstandAnimation(team, m, extras);
            } catch (err) {
              serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Endstand als Animation fehlgeschlagen — Foto');
            }
          }
        }
        // Zum Sieg Konfetti — nur in privaten Chats, siehe `mitEffekt`.
        const effekt = m.won === true ? KONFETTI_EFFECT_ID : null;
        const zustellung = png
          ? await rundsendenBild(png, text, 'endstand.png', deps, endstandTastatur(m), fuerTeam(team.team_id, ALLE), 'endstand', gif, effekt)
          : await anAlle(chatId => mitEffekt(chatId, effekt, x => deps.send(chatId, text, endstandTastatur(m), x)), fuerTeam(team.team_id, ALLE), 'endstand');
        out.messages++; out.recipients += zustellung.count;
        // Ein Sieg bekommt eine Reaktion auf die eigene Nachricht — Beiwerk, das lebendig wirkt.
        if (m.won === true && deps.react) {
          for (const z of zustellung.sent) {
            try { await deps.react(z.chatId, z.messageId, '🏆'); } catch { /* Telegram kennt das Emoji nicht oder der Chat erlaubt keine Reaktionen */ }
          }
        }
        // Der Spielbericht folgt nur auf einen Endstand, der wirklich rausging.
        merke(schluessel('result-sent'));
      }

      // --- Spielbericht ---
      // Nur nach einem gemeldeten Endstand, im Fenster; der Text der Quelle
      // kommt irgendwann nach dem Abpfiff, und `/bericht` liest ihn danach aus
      // der Datenbank.
      if (m.status === 'finished' && schonGeschickt(schluessel('result-sent')) && !schonGeschickt(schluessel('report'))) {
        if (jetzt - start > REPORT_UNTIL_MS) {
          merke(schluessel('report'));
        } else if (jetzt - start >= REPORT_FROM_MS) {
          try {
            const text = m.report_text ?? await fetchMatchReport(m.match_id);
            if (!m.report_text) out.fetches++;
            if (text) {
              merke(schluessel('report'));
              setzeBericht(team.team_id, m.match_id, text);
              const n = await rundsenden(textBericht(team, { ...m, report_text: text }, 'kurz'), deps, berichtTastatur(m, true), fuerTeam(team.team_id, ALLE), 'bericht');
              out.messages++; out.recipients += n;
            }
          } catch (err) {
            serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Spielbericht nicht abrufbar');
          }
        }
      }
    }

    // --- Saisonabschluss ---
    // Einmal je Mannschaft und Saison, wenn das letzte Spiel durch ist und
    // höchstens sieben Tage zurückliegt. Später wird nichts gemerkt: Wer den
    // Bot im Sommer einrichtet, bekommt die Karte über /saisonkarte.
    // Dazu eine Tabelle, die alle gespielten Spiele schon zählt: Der Endplatz
    // kommt aus ihr, und eine Tabelle vom Vortag nennte den falschen.
    const ende = saisonVorbei(team, now);
    const saisonKey = `${team.team_id}:${team.matches[0]?.season_id ?? 0}:saison`;
    const eigeneZeile = team.standings[0]?.rows.find(r => r.teamId === team.team_id);
    const gespieltZahl = team.matches.filter(m => m.status === 'finished' || m.rated).length;
    const tabelleAktuell = !!eigeneZeile && eigeneZeile.played >= gespieltZahl;
    if (ende.vorbei && ende.frisch && tabelleAktuell && !schonGeschickt(saisonKey)) {
      merke(saisonKey);
      const text = `🏅 <b>Die Saison ist vorbei.</b>\n${textSaison(team)}`;
      const svg = bildSaison(team);
      let png: Buffer | null = null;
      if (svg && deps.sendPhoto) {
        try { png = await renderPng(svg); } catch (err) {
          serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Saisonkarte fehlgeschlagen — Textfassung');
        }
      }
      const zustellung = png
        ? await rundsendenBild(png, text, 'saison.png', deps, null, fuerTeam(team.team_id, ALLE), 'saison')
        : await anAlle(chatId => deps.send(chatId, text), fuerTeam(team.team_id, ALLE), 'saison');
      out.messages++; out.recipients += zustellung.count;
    }
  }
  return out;
}
