-- Push der Microsite: die Themen, die ein Abonnent gewählt hat (Komma-Liste:
-- upcoming, halftime, result, change, preview). NULL heißt „aus dem Modus
-- ableiten“ (alte Zeilen: all = alle vier Spielthemen, results = Endstand
-- und Verlegungen). Die Datei läuft genau einmal (Runner).

ALTER TABLE handball_site_subscription ADD COLUMN topics TEXT;
