# Handballteck auf dem VPS der Wölfe Voreifel

Eigenständiger Betrieb auf dem IONOS-VPS des Vereins (VPS 1-2-60, Ubuntu 24.04,
`217.160.74.3`) unter **`https://app.woelfe-voreifel.de`**. Kein Komodo, kein Homelab:
Caddy holt das Zertifikat, Docker Compose betreibt beide Container.

| Datei | Zweck |
|---|---|
| `docker-compose.yml` | Dienst und Caddy, gehärtet wie bisher auf NAS1 |
| `Caddyfile` | TLS (Let's Encrypt) und Weiterleitung an den Dienst |
| `.env.example` | Vorlage für `/opt/handballteck/.env` |
| `backup.sh` | Tägliche Sicherung der SQLite-Datei, 14 Tage |

Auf dem Server liegt alles unter `/opt/handballteck` (`docker-compose.yml`, `Caddyfile`,
`backup.sh`, `.env`, `data/`, `backup/`).

**Grundregel für den Umzug:** Es läuft immer nur **eine** Instanz mit Daten und
Bot-Token. Zwei Instanzen mit demselben Token holen sich gegenseitig den Webhook weg und
schicken Meldungen doppelt. Eine kopierte Datenbank in einem Probelauf verschickt echte
Push-Nachrichten.

---

## Phase A: Server einrichten (ca. 1–2 h, der alte Dienst läuft weiter)

1. **IONOS-Firewall** (Cloud Panel → Netzwerk → Firewall-Richtlinien): eingehend nur
   TCP 22 (am besten nur von der eigenen IP), TCP 80, TCP 443 und UDP 443. Docker umgeht
   `ufw`, deshalb ist die IONOS-Firewall die maßgebliche.
2. **SSH:** eigenen Schlüssel in `~/.ssh/authorized_keys` hinterlegen. Die Anmeldung per
   Passwort bleibt an (entschieden 2026-11-16); gegen Durchprobieren sperrt `fail2ban`
   (Schritt 3) Adressen nach wiederholten Fehlversuchen.
3. **Grundpakete, fail2ban und automatische Sicherheitsupdates:**
   ```bash
   apt update && apt -y upgrade
   apt -y install unattended-upgrades fail2ban sqlite3 ca-certificates curl
   systemctl is-enabled unattended-upgrades fail2ban   # beide „enabled“
   ```
4. **Docker Engine** aus dem offiziellen Repository (docs.docker.com → Install → Ubuntu),
   samt `docker-compose-plugin`. Prüfen: `docker compose version`.
5. **Ordner und Dateien:** auf dem Server `mkdir -p /opt/handballteck`, dann vom eigenen
   Rechner aus dem Repo:
   ```bash
   scp deploy/vps/docker-compose.yml deploy/vps/Caddyfile deploy/vps/backup.sh deploy/vps/.env.example root@217.160.74.3:/opt/handballteck/
   ```
   Auf dem Server: `cd /opt/handballteck && cp .env.example .env && chmod 600 .env && chmod +x backup.sh`.
6. **Datenordner mit dem Besitzer aus dem Image** (der Container läuft als `appuser` und
   darf nur nach `/data` schreiben):
   ```bash
   docker pull ghcr.io/fauteck/handballteck:latest
   docker run --rm --entrypoint id ghcr.io/fauteck/handballteck:latest   # uid=100(appuser) gid=101(appgroup)
   mkdir -p data && chown 100:101 data
   ```
7. **DNS** beim Anbieter von `woelfe-voreifel.de`: `A`-Eintrag `app` → `217.160.74.3`
   (TTL 300). Ohne ihn bekommt Caddy kein Zertifikat.
8. **Probelauf mit leerem `data/` und ohne Bot:** In `.env` `SITE_DOMAIN`, `ACME_EMAIL`
   und `ADMIN_PASSWORD` setzen. Nach dem Start auf der Einstellungsseite (SSH-Tunnel) eine
   Mannschaft eintragen, aber **keinen** Bot-Token. Dann:
   ```bash
   docker compose up -d && docker compose logs -f
   ```
   Prüfen: `https://app.woelfe-voreifel.de/healthz` antwortet, das Zertifikat stimmt, die
   Mannschaftsseite lädt. Danach aufräumen, sonst wird die Test-Datenbank zur echten:
   ```bash
   docker compose down && rm -rf data/* && ls -la data
   ```

## Phase B: Umzug (ca. 30 min, Ausfall ca. 10–15 min)

Vorbereiten, solange der alte Dienst noch läuft:

- Alle Variablen des Komodo-Stacks `handballteck` (NAS1) notieren, Geheimnisse in KeePassXC.
- Auf der alten Einstellungsseite (`http://192.168.0.180:3411/`) „Als .env exportieren“.
  Notieren, ob dort `SITE_URL` gespeichert ist.
- `.env` auf dem VPS fertig machen: die Werte aus dem alten Stack übernehmen, aber
  `PUBLIC_URL` und `TRUST_PROXY` setzt die Compose-Datei selbst. Nach dem Umzug auf der
  Einstellungsseite „Auf diese Seite übernehmen“ (Tab Zustand) und die übrigen Werte aus der
  `.env` löschen.

Dann umziehen:

1. **Automatische Deploys auf NAS1 abschalten:** in Home Assistant die Zuordnung
   `Fauteck/handballteck` → Komodo-Stack (`script.komodo_deploy`) deaktivieren. Sonst
   startet der nächste Image-Dispatch den alten Stack wieder, und es laufen zwei Bots.
2. **Alten Dienst stoppen:** Komodo (NAS1) → Stack `handballteck` → *Stop*. Nicht löschen,
   er ist der Rückweg.
3. **Daten kopieren:** auf NAS1 den ganzen Ordner (`handballteck.db` samt `-wal`/`-shm`,
   falls vorhanden) packen und zum VPS schicken:
   ```bash
   cd /volume1/Docker/NAS/handballteck && tar czf /tmp/handballteck-data.tgz data
   scp /tmp/handballteck-data.tgz root@217.160.74.3:/opt/handballteck/
   ```
   Auf dem VPS:
   ```bash
   cd /opt/handballteck && tar xzf handballteck-data.tgz
   sqlite3 data/handballteck.db "PRAGMA integrity_check;"   # muss „ok“ sagen
   chown -R 100:101 data && chmod -R u+rwX data   # erst danach: sqlite3 als root legt -shm/-wal als root an
   ```
4. **Starten:** `docker compose up -d && docker compose logs -f handballteck`. Im Log
   steht „Handballteck läuft … erreichbar unter https://app.woelfe-voreifel.de“. Den
   Telegram-Webhook stellt der Dienst beim Start selbst auf die neue Adresse um.
5. **Einstellungsseite prüfen** (Tunnel vom eigenen Rechner aus:
   `ssh -L 3411:127.0.0.1:3411 root@217.160.74.3`, dann `http://localhost:3411/`): Steht
   dort ein gespeichertes `SITE_URL` mit der alten Domain, auf „Auf die Umgebung
   zurücksetzen“. Sonst zeigen Kalender, Feed und Vorschaubilder weiter auf die alte Adresse.
6. **Nachkontrolle:** `/healthz`, eine Mannschaftsseite, `/status` im Bot aus einem
   Admin-Chat (Webhook-Adresse muss die neue sein), eine Push-Anmeldung im Browser.
7. **Alte Domain umleiten:** im NPM auf MINT den Proxy Host `handball.fauteck.eu` durch
   einen *Redirection Host* ersetzen: Ziel `app.woelfe-voreifel.de`, HTTP-Code 301, Pfad
   erhalten, Let's Encrypt an. Damit laufen Kalender-Abos, RSS-Feeds und alte Links weiter.
8. **Vereinsseite:** den Einbettungs-Block aus der Haupt-README (Abschnitt „Embedding in
   the club website“) neu einfügen. Er zeigt auf die neue Adresse.

**Was der Domainwechsel mit bestehenden Anmeldungen macht:**

- *Telegram:* nichts. Abonnenten liegen in der Datenbank, der Webhook zieht beim Start um.
- *Browser-Push:* Bestehende Anmeldungen bekommen weiter Nachrichten, weil das VAPID-Paar
  mit der Datenbank umzieht. Ein Klick öffnet die neue Domain. Abmelden oder neu anmelden
  geht nur noch auf der neuen Domain, denn der Browser bindet die Anmeldung an die alte.
- *Kalender und RSS:* laufen über die 301-Umleitung weiter. Die Umleitung bleibt so lange
  stehen, bis keine Abrufe der alten Domain mehr im NPM-Log auftauchen.

## Betrieb

- **Weg einer Änderung:** Feature-Branch per Dispatch (`Publish Docker Image`) als `:dev`
  bauen; Home Assistant rollt es auf die Testinstanz (NAS1) aus. Dort prüfen, dann mergen
  und den Dispatch auf `main` starten: Er baut `:latest` und den SHA-Tag. Home Assistant
  meldet ihn nur, ausgerollt wird hier von Hand.
- **Update** nach dem Dispatch auf `main`:
  ```bash
  cd /opt/handballteck && docker compose pull && docker compose up -d && docker image prune -f
  ```
  Danach `/healthz` prüfen: `sha` muss der SHA des Dispatches sein.
- **Rückweg auf einen älteren Stand:** in `.env` `IMAGE_TAG=<sha>` setzen (die sieben
  Zeichen aus dem Dispatch oder `ghcr.io/fauteck/handballteck` → Packages), dann
  `docker compose up -d`. Zurück auf den laufenden Stand: Zeile entfernen, `docker compose
  pull && docker compose up -d`. Ein Rückweg über ein Datenbank-Schema hinweg geht nur mit
  der Sicherung von vorher.
- **Sicherung:** `crontab -e` → `15 3 * * * /opt/handballteck/backup.sh`. Die Dateien
  liegen auf demselben Server. Mindestens eine Kopie gehört woandershin (IONOS-Backup oder
  regelmäßig abholen).
- **Logs:** `docker compose logs --tail 200 handballteck`.
- **Einstellungsseite:** nur per SSH-Tunnel (Phase B, Schritt 5). Port 3411 nie in der
  Firewall freigeben.

## Rückweg

In den ersten zwei Wochen bleibt der NAS1-Stack gestoppt stehen:

1. VPS: `docker compose down`.
2. Daten zurück (nur wenn die Änderungen seit dem Umzug bleiben sollen): `data/` vom VPS nach
   `/volume1/Docker/NAS/handballteck/` kopieren.
3. NPM: `handball.fauteck.eu` wieder als Proxy Host auf `192.168.0.180:3410`.
4. Komodo: `PUBLIC_URL` zurück auf die alte Domain, Stack starten, HA-Zuordnung wieder an.

Nach den zwei Wochen ohne Rückweg: Ordner `handballteck_nas` in `docker-configs` entfernen
(Port-Freigaben in `scripts/host-ports.nas1.allow`, Diagramme und Host-Pfade gleich mit)
und die Zuordnung in Home Assistant löschen.
