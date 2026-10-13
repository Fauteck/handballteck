-- Protokoll der Einstellungsseite: wer wann welche Einstellung geändert hat.
-- Geheimnisse stehen nie im Klartext darin (alt/neu sind dann „●●●“).
CREATE TABLE IF NOT EXISTS settings_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  key TEXT NOT NULL,
  action TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT
);
CREATE INDEX IF NOT EXISTS settings_audit_at ON settings_audit (at);
