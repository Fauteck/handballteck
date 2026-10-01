-- Fotos von der Vereinsseite (ClubDesk), Oktober 2026: das Gruppenbild je
-- Mannschaft und bei den Senioren die Porträts aus dem Kader. Abgelegt als
-- verkleinertes JPEG — das Original ist bis zu 55 MB groß. `source_key` ist
-- die Bild-ID samt Signatur der Quelle; solange sie gleich bleibt, wird nicht
-- neu geladen. Zu sehen sind die Bilder vorerst nur in der Vorschau der Seite
-- (`SITE_PREVIEW_TOKEN`), bis die Bildrechte geklärt sind.

CREATE TABLE IF NOT EXISTS clubdesk_photo (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  contact_id TEXT,
  name TEXT,
  section TEXT,
  position TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  source_key TEXT NOT NULL,
  image BLOB NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS clubdesk_photo_team ON clubdesk_photo (team_id, kind);
