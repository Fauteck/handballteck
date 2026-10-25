-- PRF-4-002: `changesFor` liest Verlegungen je Mannschaft — ohne Index ein
-- Tabellen-Scan bei jedem Aufbau der Übersicht.
-- PRF-4-001: Die Merker der Bot-Meldungen werden nach einem Jahr gelöscht;
-- das Löschen geht über `sent_at`.
-- Idempotent; der Runner wendet die Datei genau einmal an.

CREATE INDEX IF NOT EXISTS idx_handball_match_change_team ON handball_match_change(team_id);
CREATE INDEX IF NOT EXISTS idx_handball_bot_sent_at ON handball_bot_sent(sent_at);
