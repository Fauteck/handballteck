-- Handballteck, Ausgangsstand (28.09.2026): dieselben Tabellen, die bis dahin
-- in Todoteck lagen (dort Migrationen 0092 bis 0104), in ihrer Endform —
-- plus `settings` (VAPID-Schlüssel) und `handball_bot_subscriber.team_ids`.
-- Die Namen sind geblieben, damit `scripts/import-todoteck.ts` Zeile für
-- Zeile übernehmen kann.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handball_team_match (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  season_id INTEGER NOT NULL,
  starts_at TEXT NOT NULL,
  status TEXT NOT NULL,
  status_name TEXT NOT NULL,
  round INTEGER,
  phase_id INTEGER,
  competition_name TEXT NOT NULL,
  championship_name TEXT,
  home_id TEXT NOT NULL,
  home_name TEXT NOT NULL,
  away_id TEXT NOT NULL,
  away_name TEXT NOT NULL,
  score_home INTEGER,
  score_away INTEGER,
  venue_name TEXT,
  venue_address TEXT,
  venue_lat REAL,
  venue_lon REAL,
  report_url TEXT,
  home_logo_url TEXT,
  away_logo_url TEXT,
  report_text TEXT,
  halftime_home INTEGER,
  halftime_away INTEGER,
  lineup_stored_at TEXT,
  unfinished_seen_at TEXT,
  finished_seen_at TEXT,
  kickoff_estimated_at TEXT,
  tz_check TEXT,
  events_payload TEXT,
  notified_upcoming INTEGER NOT NULL DEFAULT 0,
  notified_result INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handball_team_match_team_start ON handball_team_match(team_id, starts_at);

CREATE TABLE IF NOT EXISTS handball_match_player (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  is_goalkeeper INTEGER NOT NULL DEFAULT 0,
  is_captain INTEGER NOT NULL DEFAULT 0,
  goals INTEGER NOT NULL DEFAULT 0,
  seven_meter_goals INTEGER NOT NULL DEFAULT 0,
  seven_meter_attempts INTEGER NOT NULL DEFAULT 0,
  two_minutes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handball_match_player_team ON handball_match_player(team_id, player_id);

CREATE TABLE IF NOT EXISTS handball_match_change (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  old_starts_at TEXT NOT NULL,
  new_starts_at TEXT NOT NULL,
  detected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handball_team_logo (
  team_id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  image BLOB NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handball_standings (
  phase_id INTEGER PRIMARY KEY,
  season_id INTEGER NOT NULL,
  competition_name TEXT NOT NULL,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  previous_payload TEXT,
  previous_fetched_at TEXT,
  history_payload TEXT
);

CREATE TABLE IF NOT EXISTS handball_bot_instance (
  id INTEGER PRIMARY KEY,
  webhook_path_secret TEXT NOT NULL,
  webhook_header_secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  description_text TEXT,
  short_description_text TEXT,
  admin_menu_chats TEXT
);

CREATE TABLE IF NOT EXISTS handball_bot_subscriber (
  chat_id TEXT PRIMARY KEY,
  name TEXT,
  subscribed_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  lead TEXT,
  mode TEXT,
  team_ids TEXT
);

CREATE TABLE IF NOT EXISTS handball_bot_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  name TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  done_at TEXT
);

CREATE TABLE IF NOT EXISTS handball_bot_delivery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT,
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handball_bot_delivery_sent ON handball_bot_delivery(sent_at);

CREATE TABLE IF NOT EXISTS handball_roster (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  number INTEGER,
  role TEXT NOT NULL,
  season_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handball_roster_team ON handball_roster(team_id);

CREATE TABLE IF NOT EXISTS handball_bot_sent (
  id TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handball_opponent_form (
  team_id TEXT PRIMARY KEY,
  season_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handball_site_subscription (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  lead TEXT NOT NULL DEFAULT '1h',
  mode TEXT NOT NULL DEFAULT 'all',
  user_agent TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_handball_site_subscription_team ON handball_site_subscription(team_id);
