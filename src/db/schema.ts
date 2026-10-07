/**
 * Datenbankschema von Handballteck — die Tabellen, die bis zum 28.09.2026
 * unter demselben Namen in Todoteck lagen (Migrationen 0092 bis 0104 dort).
 * Die Namen sind bewusst geblieben, damit `scripts/import-todoteck.ts` die
 * Zeilen eins zu eins übernehmen kann.
 *
 * Neu gegenüber Todoteck: `settings` (VAPID-Schlüssel, die vorher in
 * `app_settings` lagen) und `handball_bot_subscriber.team_ids` — welche
 * Mannschaften ein Chat verfolgt, seit der Bot mehrere kennt.
 */
import { sqliteTable, text, integer, real, blob } from 'drizzle-orm/sqlite-core';

/** Schlüssel-Wert-Ablage der Instanz (VAPID-Schlüsselpaar). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updated_at: text('updated_at').notNull(),
});

/**
 * Spiele der verfolgten Handball-Mannschaften (Migration 0092,
 * Wiki „Handball-Verfolgung (handball.net)“). Eine Zeile je Mannschaft und Spiel, geschrieben
 * vom Tageslauf, nachgefasst am Spieltag; die Merker gehören den Meldungen.
 */
export const handball_team_match = sqliteTable('handball_team_match', {
  /** `${team_id}:${match_id}` — dasselbe Spiel kann bei zwei verfolgten Mannschaften stehen. */
  id: text('id').primaryKey(),
  team_id: text('team_id').notNull(),
  match_id: text('match_id').notNull(),
  season_id: integer('season_id').notNull(),
  /** Anwurf in UTC (ISO), aus der Ortszeit der Quelle gerechnet. */
  starts_at: text('starts_at').notNull(),
  /** scheduled · live · finished · postponed · cancelled · other */
  status: text('status').notNull(),
  status_name: text('status_name').notNull(),
  round: integer('round'),
  phase_id: integer('phase_id'),
  competition_name: text('competition_name').notNull(),
  championship_name: text('championship_name'),
  home_id: text('home_id').notNull(),
  home_name: text('home_name').notNull(),
  away_id: text('away_id').notNull(),
  away_name: text('away_name').notNull(),
  score_home: integer('score_home'),
  score_away: integer('score_away'),
  venue_name: text('venue_name'),
  venue_address: text('venue_address'),
  /** Koordinaten der Halle (Migration 0095) — für den Routen-Knopf des Bots. */
  venue_lat: real('venue_lat'),
  venue_lon: real('venue_lon'),
  /** Der offizielle Spielberichtsbogen als PDF (Feld `report` der Quelle). */
  report_url: text('report_url'),
  /** Vereinslogos beider Seiten (`club.logo`) — nur zum Holen durch den Tageslauf, nie zum Ausliefern. */
  home_logo_url: text('home_logo_url'),
  away_logo_url: text('away_logo_url'),
  /** Der Spielbericht der Quelle (`additional-info`, `chronicle`) als Text; null, bis er da ist. */
  report_text: text('report_text'),
  /** Halbzeitstand aus der Torfolge, sobald der Bot ihn gesehen hat. */
  halftime_home: integer('halftime_home'),
  halftime_away: integer('halftime_away'),
  /** Wann die Aufstellung dieses Spiels nach `handball_match_player` geschrieben wurde. */
  lineup_stored_at: text('lineup_stored_at'),
  /**
   * Zeitzonen-Selbsttest (Migration 0099, Wiki „Handball-Verfolgung (handball.net)“ §6):
   * wann der Abruf das Spiel zuletzt **nicht** beendet und wann er es zuerst
   * beendet gesehen hat — beides echte UTC-Zeit dieser Instanz. Aus dem
   * Fenster dazwischen und `starts_at` folgt `tz_check`:
   * confirmed · suspect_early · suspect_late · inconclusive; null = ungeprüft.
   */
  unfinished_seen_at: text('unfinished_seen_at'),
  finished_seen_at: text('finished_seen_at'),
  /**
   * Der geschätzte echte Anwurf (UTC) aus einer live gelesenen Torfolge:
   * Abrufzeit minus Spielminute des jüngsten Ereignisses. Die Quelle nennt
   * keine Uhrzeit je Ereignis, nur die Spieluhr — die Schätzung ist deshalb
   * eine obere Grenze (Unterbrechungen, Pause).
   */
  kickoff_estimated_at: text('kickoff_estimated_at'),
  tz_check: text('tz_check'),
  /**
   * Die Torfolge des beendeten Spiels (Migration 0104, Wiki „Handball-Verfolgung (handball.net)“ §7.5):
   * JSON-Array von HandballMatchEventItem — Spielminute, Stand danach, Tor
   * ja/nein. `[]` heißt „geholt, die Quelle hat keine"; null heißt „noch nie
   * geholt". Für den Spielverlauf auf der Microsite.
   */
  events_payload: text('events_payload'),
  notified_upcoming: integer('notified_upcoming', { mode: 'boolean' }).notNull().default(false),
  notified_result: integer('notified_result', { mode: 'boolean' }).notNull().default(false),
  updated_at: text('updated_at').notNull(),
});

/**
 * Aufstellung je Spiel und Spieler (Migration 0095, Wiki „Handball-Verfolgung (handball.net)“ §5):
 * die Zahlen, die die Quelle je Spiel liefert und die bis dahin nur für die
 * eine Endstand-Nachricht gelesen und dann weggeworfen wurden. Grundlage der
 * Spielerbilanz (`/spieler`). Nur die eigene Mannschaft.
 */
export const handball_match_player = sqliteTable('handball_match_player', {
  /** `${team_id}:${match_id}:${player_id}` */
  id: text('id').primaryKey(),
  team_id: text('team_id').notNull(),
  match_id: text('match_id').notNull(),
  player_id: text('player_id').notNull(),
  number: integer('number').notNull(),
  is_goalkeeper: integer('is_goalkeeper', { mode: 'boolean' }).notNull().default(false),
  /** Kapitän in dieser Aufstellung (Migration 0098) — die Marke „C" im Kader kommt aus der letzten. */
  is_captain: integer('is_captain', { mode: 'boolean' }).notNull().default(false),
  goals: integer('goals').notNull().default(0),
  seven_meter_goals: integer('seven_meter_goals').notNull().default(0),
  seven_meter_attempts: integer('seven_meter_attempts').notNull().default(0),
  two_minutes: integer('two_minutes').notNull().default(0),
  updated_at: text('updated_at').notNull(),
});

/**
 * Verlegungen und Absagen (Migration 0095): Was der Abruf an einem schon
 * gespeicherten Spiel geändert vorfindet — neuer Anwurf, Status „verschoben"
 * oder „abgesetzt". Der Bot meldet je Zeile einmal (Merker in
 * `handball_bot_sent`); die Zeile bleibt als Verlauf.
 */
export const handball_match_change = sqliteTable('handball_match_change', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  team_id: text('team_id').notNull(),
  match_id: text('match_id').notNull(),
  /** rescheduled · postponed · cancelled */
  kind: text('kind').notNull(),
  old_starts_at: text('old_starts_at').notNull(),
  new_starts_at: text('new_starts_at').notNull(),
  detected_at: text('detected_at').notNull(),
});

/**
 * Vereinslogo je Mannschaft im Spielplan (Migration 0095) — die eigene und
 * jeder Gegner, damit die Endstand-Karte beide zeigt: einmal von der Quelle
 * geholt (`club.logo` am Spiel, liegt bei handball360.isquad.de), lokal
 * abgelegt, in die Bilder des Bots eingebettet. Wie bei den Darts-Fotos:
 * die fremde URL nur serverseitig zum Holen, nie zum Ausliefern.
 */
export const handball_team_logo = sqliteTable('handball_team_logo', {
  team_id: text('team_id').primaryKey(),
  source_url: text('source_url').notNull(),
  mime_type: text('mime_type').notNull(),
  image: blob('image', { mode: 'buffer' }).notNull(),
  fetched_at: text('fetched_at').notNull(),
});

/** Tabelle je Staffel, als JSON-Zeilen — die Quelle liefert sie fertig gerechnet. */
export const handball_standings = sqliteTable('handball_standings', {
  phase_id: integer('phase_id').primaryKey(),
  season_id: integer('season_id').notNull(),
  competition_name: text('competition_name').notNull(),
  /** JSON-Array von HandballStandingRow. */
  payload: text('payload').notNull(),
  fetched_at: text('fetched_at').notNull(),
  /** Der Stand davor (Migration 0096) — für „von 3 auf 2 geklettert" und die Tendenzpfeile. */
  previous_payload: text('previous_payload'),
  previous_fetched_at: text('previous_fetched_at'),
  /**
   * Der Stand nach jedem gespielten Spieltag (Migration 0097) — JSON-Array von
   * HandballStandingRow mit dem `round` der Quelle; daraus der
   * Tabellenplatz-Verlauf in `/saison`. Kommt aus demselben Abruf wie `payload`.
   */
  history_payload: text('history_payload'),
});

/**
 * Handball-Telegram-Bot (Migration 0093, Wiki „Handball-Verfolgung (handball.net)“ §5):
 * Webhook-Geheimnisse wie beim Todoteck-Bot (`telegram_instance`), aber
 * eigene Zeile, weil es ein eigener Bot mit eigenem Webhook ist.
 */
export const handball_bot_instance = sqliteTable('handball_bot_instance', {
  id: integer('id').primaryKey(),
  webhook_path_secret: text('webhook_path_secret').notNull(),
  webhook_header_secret: text('webhook_header_secret').notNull(),
  created_at: text('created_at').notNull(),
  /** Zuletzt an Telegram gesetzte Beschreibung (`setMyDescription`) — gesetzt wird nur bei Änderung (Migration 0101). */
  description_text: text('description_text'),
  /** Dasselbe für die Kurzbeschreibung (`setMyShortDescription`). */
  short_description_text: text('short_description_text'),
  /** Admin-Chats mit eigenem Befehlsmenü, durch Komma getrennt — zum Aufräumen ausgetragener (Migration 0101). */
  admin_menu_chats: text('admin_menu_chats'),
});

/** Wer den Bot abonniert hat — Telegram-Chats, keine Todoteck-Nutzer. */
export const handball_bot_subscriber = sqliteTable('handball_bot_subscriber', {
  chat_id: text('chat_id').primaryKey(),
  /** Vorname oder Nutzername aus Telegram, nur für die Dienste-Karte. */
  name: text('name'),
  subscribed_at: text('subscribed_at').notNull(),
  last_seen_at: text('last_seen_at').notNull(),
  /** Vorlauf der Ankündigung (Migration 0096): 1h · 3h · abend · aus; null heißt 1h. */
  lead: text('lead'),
  /** all · results — wer nur den Endstand will, bekommt Ankündigung, Aufstellung und Halbzeit nicht. */
  mode: text('mode'),
  /**
   * Welche Mannschaften der Chat verfolgt (`/teams`): Team-IDs durch Komma,
   * null oder leer heißt **alle**. Seit der Dienst mehrere Mannschaften eines
   * Vereins kennt, wählt jeder Abonnent selbst.
   */
  team_ids: text('team_ids'),
});

/** Rückmeldungen aus dem Chat (`/feedback`, Migration 0096) — an den Betreiber weitergereicht und hier aufgehoben. */
export const handball_bot_feedback = sqliteTable('handball_bot_feedback', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chat_id: text('chat_id').notNull(),
  name: text('name'),
  text: text('text').notNull(),
  created_at: text('created_at').notNull(),
  /** Vom Betreiber als erledigt markiert (Migration 0097, `/erledigt` oder der Knopf unter `/status`). */
  done_at: text('done_at'),
});

/**
 * Zustell-Protokoll des Handball-Bots (Migration 0097): eine Zeile je Chat
 * und Meldung, gelungen oder nicht — damit `/status` sagen kann, wie viele
 * Meldungen in den letzten Wochen rausgingen und welche Chats nicht mehr
 * erreichbar sind. Antworten auf Befehle stehen nicht drin, nur was der Bot
 * von sich aus schickt. 90 Tage Aufbewahrung, danach räumt der Bot beim
 * nächsten Eintrag auf.
 */
export const handball_bot_delivery = sqliteTable('handball_bot_delivery', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chat_id: text('chat_id').notNull(),
  /** ankuendigung · aufstellung · halbzeit · endstand · bericht · aenderung · rundruf */
  kind: text('kind').notNull(),
  ok: integer('ok').notNull(),
  /** Bei einem Fehlschlag die Meldung von Telegram, kurz. */
  detail: text('detail'),
  sent_at: text('sent_at').notNull(),
});

/**
 * Kader der verfolgten Mannschaften (Migration 0094): die Namen, die die
 * Aufstellung maskiert, über die Spieler-ID zugeordnet — nie über die Nummer.
 */
export const handball_roster = sqliteTable('handball_roster', {
  /** `${team_id}:${player_id}` */
  id: text('id').primaryKey(),
  team_id: text('team_id').notNull(),
  player_id: text('player_id').notNull(),
  first_name: text('first_name').notNull(),
  last_name: text('last_name').notNull(),
  number: integer('number'),
  /** player · staff */
  role: text('role').notNull(),
  season_id: integer('season_id').notNull(),
  updated_at: text('updated_at').notNull(),
});

/** Merker je Spiel und Meldungsart (`${team_id}:${match_id}:${kind}`), damit nichts zweimal geht. */
export const handball_bot_sent = sqliteTable('handball_bot_sent', {
  id: text('id').primaryKey(),
  sent_at: text('sent_at').notNull(),
});

/**
 * Web-Push-Abonnenten der Handball-Microsite (Migration 0103,
 * Wiki „Handball-Verfolgung (handball.net)“ §7): Browser ohne Todoteck-Konto und ohne
 * Telegram, die auf der Seite die Glocke gedrückt haben. Eine Zeile je
 * Browser-Subscription (der Endpoint ist der Schlüssel des Push-Dienstes),
 * mit Vorlauf und Modus wie beim Bot-Abonnenten. Kein Nutzerbezug — wer
 * hier steht, ist nur ein Endpoint. `failures` zählt vorübergehende
 * Fehlschläge in Folge; eine tote Subscription (404/410/403) fliegt sofort.
 */
/**
 * Der Spielplan des nächsten Gegners (Migration 0104, Wiki „Handball-Verfolgung (handball.net)“ §7.5):
 * einmal je Tageslauf geholt, damit Microsite und Ankündigung seine letzten
 * Ergebnisse zeigen können, ohne dass eine öffentliche Seite einen Abruf
 * nach draußen auslöst. `payload` ist ein JSON-Array von HandballMatch.
 */
export const handball_opponent_form = sqliteTable('handball_opponent_form', {
  /** Die Mannschaft des Gegners (Team-ID der Quelle). */
  team_id: text('team_id').primaryKey(),
  season_id: integer('season_id').notNull(),
  payload: text('payload').notNull(),
  fetched_at: text('fetched_at').notNull(),
});

export const handball_site_subscription = sqliteTable('handball_site_subscription', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  team_id: text('team_id').notNull(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  /** 1h · 3h · abend · aus */
  lead: text('lead').notNull().default('1h'),
  /** all · results */
  mode: text('mode').notNull().default('all'),
  user_agent: text('user_agent'),
  failures: integer('failures').notNull().default(0),
  created_at: text('created_at').notNull(),
  last_seen_at: text('last_seen_at').notNull(),
  last_sent_at: text('last_sent_at'),
});

/**
 * Fotos von der Vereinsseite (Migration 0002): `gruppe` je Mannschaft, `person`
 * je Kachel des Kaders (nur Senioren). Verkleinert als JPEG abgelegt.
 */
export const clubdesk_photo = sqliteTable('clubdesk_photo', {
  /** `${team_id}:gruppe` oder `${team_id}:person:${contact_id}` */
  id: text('id').primaryKey(),
  team_id: text('team_id').notNull(),
  kind: text('kind').notNull(),
  contact_id: text('contact_id'),
  name: text('name'),
  section: text('section'),
  position: text('position'),
  sort: integer('sort').notNull().default(0),
  source_key: text('source_key').notNull(),
  image: blob('image', { mode: 'buffer' }).notNull(),
  fetched_at: text('fetched_at').notNull(),
});
