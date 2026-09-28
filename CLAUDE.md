# CLAUDE.md — Handballteck

Handballteck follows one club's handball teams from handball.net: public microsite,
Telegram bot, browser push, calendar subscription, RSS feed, and a token-protected
API for the Todoteck cockpit. It was carved out of
[Todoteck](https://github.com/Fauteck/todo) on 2026-09-28.

## Where knowledge lives

- **This repo:** code, `README.md` (setup, configuration, API), `.env.example`
  (the complete list of variables — every variable the code reads is in it).
- **Todoteck, `docs/handball-verfolgung.md`:** the history and reasoning behind every
  feature — source checks, the time-zone reading, the bot's rounds, the microsite, the
  split (§8). Link to it; do not copy it here.
- **llm-wiki (Todoteck project):** cross-project knowledge, as for every Fauteck repo.

## Binding rules

- **German user-facing text uses Umlauts** (ä, ö, ü, ß) — bot messages, the page,
  log lines, comments, commit messages. Identifiers stay ASCII.
- **Configuration is environment only.** No settings UI, no per-user state. A new
  variable goes into `.env.example` with its default in the same change.
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
  JavaScript (CSP).

## Verification

```bash
npm ci
npm run typecheck
npm test          # sequential: test files share module state
```

Run the test file that covers a change; run the whole suite when behaviour is removed
(a call path deleted, a trigger dropped) — the tests that break are elsewhere.
