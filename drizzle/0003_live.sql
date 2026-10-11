-- Live-Ansicht der Microsite: der jüngste Stand eines laufenden Spiels
-- (Spielminute, Halbzeit, letzte Ereignisse) als JSON am Spiel. Getrennt von
-- `events_payload`, damit die vollständige Torfolge nach dem Abpfiff weiter
-- vom Tageslauf geholt wird — ein Zwischenstand darf sie nicht ersetzen.
-- Die Datei läuft genau einmal (Runner), ein zweites ADD COLUMN gibt es nicht.

ALTER TABLE handball_team_match ADD COLUMN live_payload TEXT;
