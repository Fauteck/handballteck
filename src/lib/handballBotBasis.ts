/**
 * Die Grundlage des Bots: Fristen und Befehle, Token und Geheimnisse,
 * Registrierung des Webhooks, die Abonnenten in der Datenbank und der
 * Blick auf den Webhook bei Telegram (`getWebhookInfo`). Aus `handballBot.ts`
 * gelöst (ARC-3-001) — sie braucht nichts aus dem Kern, Kern, Meldungen und
 * Beschreibung bauen auf ihr auf.
 */

import crypto from 'node:crypto';
import { type BotCommand, setWebhook, setMyCommands, getMe, deleteMyCommands, type TelegramWebhookInfo, getWebhookInfo } from './telegramClient';
import { botToken as configBotToken, inviteCode as configInviteCode, adminChatIds as configAdminChatIds, publicUrl as configPublicUrl } from '../config';
import { db } from '../db';
import { handball_bot_instance, handball_bot_subscriber, handball_bot_delivery, handball_bot_feedback } from '../db/schema';
import { eq, gte, isNull } from 'drizzle-orm';
import { botIdentity, ZEIT } from './handballBotTexts';
import { serviceLog } from './serviceLogger';
import { type HandballTeamView } from './handballSicht';

/** Wie lange nach dem Anwurf `/live` ein angesetztes Spiel noch als laufend nimmt. */
export const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Fenster, in dem nach der Aufstellung gesehen wird. */
export const LINEUP_FROM_MS = -5 * 60 * 1000;
export const LINEUP_UNTIL_MS = 30 * 60 * 1000;
/** Ein Endstand, der älter ist, gilt als Vergangenheit und wird nur gemerkt. */
export const RESULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/**
 * Eine Wertung kommt Tage nach dem Spiel (die Spielleitung entscheidet über
 * Abbruch und Nichtantreten) — sie darf deshalb älter sein als ein Endstand.
 * Zwei Wochen: Beim ersten Lauf nach dem Einrichten kommen keine Wertungen
 * aus der Hinrunde.
 */
export const RATED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Fenster für den Halbzeitstand: 2 × 25 Minuten Jugendspiel, die erste Hälfte
 * ist mit Unterbrechungen nach 27 bis 30 Minuten vorbei. Bei einem Takt von
 * 15 Minuten sind das zwei Blicke in die Torfolge; danach gibt der Bot auf.
 */
export const HALFTIME_FROM_MS = 27 * 60 * 1000;
export const HALFTIME_UNTIL_MS = 60 * 60 * 1000;
/**
 * Fenster für den Spielbericht: Die Quelle schreibt ihn irgendwann nach dem
 * Abpfiff (am 26.09.2026 stand er zwei Stunden nach Anwurf). Gesehen wird ab
 * 75 Minuten nach Anwurf je Takt, bis acht Stunden danach — höchstens 27
 * Blicke für ein Spiel am Samstagnachmittag.
 */
export const REPORT_FROM_MS = 75 * 60 * 1000;
export const REPORT_UNTIL_MS = 8 * 60 * 60 * 1000;
/** Eine Verlegung, die der Abruf vor mehr als einem Tag gesehen hat, wird nur gemerkt (erster Lauf mit Abonnenten). */
export const CHANGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** So viel Abstand muss zwischen Spieltagsgruß und Ankündigung liegen, sonst entfällt der Gruß. */
export const GRUSS_ABSTAND_ZUR_ANKUENDIGUNG_MS = 2 * 60 * 60 * 1000;

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
export const DEFAULT_LEAD: Lead = '1h';

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

export function inviteCode(): string | null {
  return configInviteCode();
}

/** Die Admin-Chats aus der Konfiguration — leer, wenn keiner eingetragen ist. */
export function adminChatIds(): Set<string> {
  return configAdminChatIds();
}

export function istAdmin(chatId: string): boolean {
  return adminChatIds().has(chatId);
}

export function publicUrl(): string {
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
export let webhookZustand: { ok: boolean; error: string | null; at: string } | null = null;

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
export let inlineAn: boolean | null = null;

/** Was `getMe` über den Inline-Modus sagt — gesetzt vom Kern, gelesen von `/status`. */
export function setzeInlineAn(wert: boolean | null): void {
  inlineAn = wert;
}

export function instanzZeile() {
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

export function setTeams(chatId: string, teamIds: string[] | null): void {
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

export function setLead(chatId: string, lead: Lead): void {
  db.update(handball_bot_subscriber).set({ lead }).where(eq(handball_bot_subscriber.chat_id, chatId)).run();
}

export function setMode(chatId: string, mode: Mode): void {
  db.update(handball_bot_subscriber).set({ mode }).where(eq(handball_bot_subscriber.chat_id, chatId)).run();
}

export function abonnent(chatId: string): HandballSubscriber | null {
  return listSubscribers().find(s => s.chatId === chatId) ?? null;
}

export function subscribe(chatId: string, name: string | null): boolean {
  const now = new Date().toISOString();
  const existing = db.select().from(handball_bot_subscriber).where(eq(handball_bot_subscriber.chat_id, chatId)).get();
  if (existing) {
    db.update(handball_bot_subscriber).set({ name, last_seen_at: now }).where(eq(handball_bot_subscriber.chat_id, chatId)).run();
    return false;
  }
  db.insert(handball_bot_subscriber).values({ chat_id: chatId, name, subscribed_at: now, last_seen_at: now }).run();
  return true;
}

export function unsubscribe(chatId: string): boolean {
  const r = db.delete(handball_bot_subscriber).where(eq(handball_bot_subscriber.chat_id, chatId)).run();
  return r.changes > 0;
}

export function touch(chatId: string): void {
  db.update(handball_bot_subscriber).set({ last_seen_at: new Date().toISOString() })
    .where(eq(handball_bot_subscriber.chat_id, chatId)).run();
}

export function istAbonnent(chatId: string): boolean {
  return !!db.select().from(handball_bot_subscriber).where(eq(handball_bot_subscriber.chat_id, chatId)).get();
}


// ---------------------------------------------------------------------------
// Webhook bei Telegram nachsehen (getWebhookInfo)
// ---------------------------------------------------------------------------

/** Wie alt die Auskunft von Telegram höchstens sein darf, bevor sie neu geholt wird. */
const WEBHOOK_INFO_MAX_ALTER_MS = 10 * 60 * 1000;
/** Ab so vielen wartenden Updates ist der Bot gelb — Telegram kommt nicht durch. */
const WEBHOOK_STAU = 50;

export let webhookInfo: { at: number; info: TelegramWebhookInfo | null; fehler: string | null } | null = null;
export let webhookInfoLaeuft: Promise<void> | null = null;

/** Nur für Tests: der Zustand der Grundlage, wie nach dem Start. */
export function __resetHandballBotBasisForTests(): void {
  webhookZustand = null;
  inlineAn = null;
  webhookInfo = null;
  webhookInfoLaeuft = null;
}

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

export function offeneRueckmeldungen() {
  return db.select().from(handball_bot_feedback).where(isNull(handball_bot_feedback.done_at)).all()
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Gelungen und gescheitert in den letzten 7 und 28 Tagen, dazu je Chat der jüngste Fehlschlag. */
export function zustellBilanz(now: Date) {
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

/** Was eine Runde an Abonnenten zugestellt hat. */
export interface Zustellung {
  count: number;
  /** Chat und Nachrichten-ID je gelungener Zustellung — für die Reaktion auf den Sieg. */
  sent: Array<{ chatId: string; messageId: number }>;
}
