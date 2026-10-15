# CLAUDE.md — Handballteck

Handballteck follows one club's handball teams from handball.net: public microsite,
Telegram bot, browser push, calendar subscription, RSS feed, and a token-protected
API for the Todoteck cockpit. It was carved out of
[Todoteck](https://github.com/Fauteck/todo) on 2026-09-28.

## Where knowledge lives

- **This repo:** code, `README.md` (setup, configuration, API), `.env.example`
  (the complete list of variables — every variable the code reads is in it).
- **Wiki „Handball-Verfolgung (handball.net)“ (llm-wiki):** the history and reasoning behind every
  feature — source checks, the time-zone reading, the bot's rounds, the microsite, the
  split (§8). Link to it; do not copy it here.
- **llm-wiki (Todoteck project):** cross-project knowledge, as for every Fauteck repo.
  Overview note: `handballteck`.

<!-- heimat-regel v1 -->
**Heimat-Regel (gilt für jedes Fauteck-Repo, entschieden 2026-10-07).** Wissen lebt im Todoteck-Wiki `llm-wiki`. Im Repo liegt **nur**, was im selben PR wie der Code geändert oder von einem Guard oder Test geprüft wird: README, `CLAUDE.md`, Architektur-, Muster- und Konventions-Doku, API-Vertrag, Schema, Setup, Checklisten, Mechanik der Guards und Jobs. **Konzepte, Entscheidungen, Phasenverläufe, Befund-Berichte und Wissen über fremde Dienste gehören ins Wiki** — nicht in `docs/`, nicht als Notiz ins Projekt Home Lab. **Todoteck-Inhalte außerhalb von `llm-wiki` sind keine Wissensquelle** — Aufgaben, Unteraufgaben und Notizen in anderen Projekten (auch wenn dort Vibecoding-Projekte geplant werden) sind Momentaufnahmen für Menschen. Weder Claude Code noch ein Repo noch das Wiki stützt sich auf sie oder verweist auf sie als Beleg; was dort an Wissen entsteht, wird ins Wiki übernommen. Jede Datei in `docs/` trägt in ihrer ersten Zeile `<!-- heimat: repo — ändert sich mit: <Code-Pfad oder Guard> -->`; ein Konzept, das gerade gebaut wird, trägt stattdessen `<!-- heimat: repo — in Arbeit bis: JJJJ-MM-TT -->` und zieht bis dahin ins Wiki um. Aus Code und Doku wird auf Wiki-Seiten mit `Wiki „Seitentitel“ §n` verwiesen. Prüffrage vor jeder neuen Datei in `docs/`: *Muss sie sich ändern, wenn sich der Code ändert, oder prüft sie ein Guard?* Wenn nein, ist sie eine Wiki-Seite. Der Guard dieses Repos und der Todoteck-Job `wiki_repo_check` prüfen das.
<!-- /heimat-regel -->

In this repo that leaves code, `README.md`, `CLAUDE.md` and `.env.example`; there is no
`docs/` folder, and concepts and decisions go to the wiki.

## Binding rules

- **German user-facing text uses Umlauts** (ä, ö, ü, ß) — bot messages, the page,
  log lines, comments, commit messages. Identifiers stay ASCII.
- **Configuration is the environment plus the settings page `/settings`** (decided
  2026-10-13; it replaces „environment only, no settings UI“). Precedence: page >
  environment > default. Still no per-user state; the page has exactly one admin account,
  taken from the environment (`ADMIN_USER`, `ADMIN_PASSWORD`, optional `ADMIN_PORT`).
  A new variable goes into `.env.example` with its default in the same change; if it
  can be edited on the page it also goes into `src/lib/settingsRegistry.ts` (the guard
  test `settings.test.ts` keeps registry, `.env.example` and README together). Secrets
  (`TELEGRAM_BOT_TOKEN`, `API_TOKEN`, `VAPID_*`) and what is needed before the database
  opens (`PORT`, `DATA_DIR`, `DATABASE_PATH`, `TRUST_PROXY`, `PUBLIC_URL`, …) stay
  environment only.
- **No secrets in the repo.** Tokens come from `.env`, which is never committed.
- **Schema changes only via a new file in `drizzle/`** (`NNNN_name.sql`, idempotent:
  `CREATE TABLE IF NOT EXISTS`, guarded `ALTER`). The runner applies each file once.
- **`/api/*` is a contract** with Todoteck (`apps/api/src/lib/handballService.ts`,
  `apps/web/src/hooks/useHandball.ts` there). Change its shape in both repos together,
  and keep old fields until Todoteck no longer reads them.
- **Images only by manual dispatch** of `.github/workflows/publish.yml`. Never add an
  automatic trigger; new checks go as steps into its `quality` job, not into a second
  workflow. Production is deployed from `docker-configs`, never by `docker compose up`
  on a server, never by hand in Portainer.
- **OWASP applies**: the microsite, the webhook and the inline images are public.
  Every public route keeps its rate limit and its reason to be open; no inline
  JavaScript (CSP). `/settings` is the one place with a login and a cookie: it stays
  off without `ADMIN_PASSWORD`, writes only with CSRF token and Origin check, never sends
  secrets back to the browser and never logs values.

## Verification

```bash
npm ci
npm run typecheck
npm test          # sequential: test files share module state
npm run test:e2e  # the settings page in Chromium (after npx playwright-core install chromium)
```

Run the test file that covers a change; run the whole suite when behaviour is removed
(a call path deleted, a trigger dropped) — the tests that break are elsewhere.
