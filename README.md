# Handballteck

![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![Fastify](https://img.shields.io/badge/fastify-5-black) ![SQLite](https://img.shields.io/badge/sqlite-better--sqlite3-blue) ![License](https://img.shields.io/badge/license-MIT-lightgrey)

Follow the handball teams of one club from [handball.net](https://www.handball.net): a public
microsite in the club's colours, a Telegram bot, browser push, a calendar subscription
and an RSS feed — in one container, without an account for anyone who just wants to
know when the next match is. A small token-protected API feeds the Todoteck cockpit.

This service was carved out of [Todoteck](https://github.com/Fauteck/todo) on
2026-09-28; Wiki „Handball-Verfolgung (handball.net)“ in the llm-wiki tells the story and the reasoning
behind every feature (§8 covers the split). Todoteck keeps a cockpit that reads this
service's `/api/*`.

## Feature overview

| Feature | What it does |
|---|---|
| Fetch | Once per calendar day: season, schedule, standings (with per-matchday history), roster, logos, opponent form. On match day: follow-up from throw-off + 45 min until the final score, then the standings once. Backfill of lineups, logos, event lists and match reports in small batches per tick. |
| Microsite | `/<team-id>/` — next match with opponent profile, last result, standings with trend arrows, schedule with match timelines, season chart, squad (names only with `SITE_PLAYERS`). Buttons at the top switch between all teams of the club; a button switches the colour scheme (auto → light → dark, remembered per browser). Live countdown (to the second in the last hour), **live mode** (the page refreshes itself every 30 s while a match runs, shows a silent goal toast with vibration and a full goal ticker), a **match page** per played match (`/<team-id>/spiel/<match-id>`: score, half-time, final-score image, timeline, goal sequence; scorers and report with `SITE_PLAYERS`), an **overview of all teams** (`/uebersicht/`: live, next 7 days, last 7 days), schedule filter (home/away/upcoming/played) with a jump to the next match, collapsible "Nichts verpassen" tiles that remember their state (push bell, Telegram, `webcal://` subscription, RSS feed), goal-scorer progression chart (with `SITE_PLAYERS`), installable PWA (icons, shortcuts, offline fallback of the last loaded page). Style and script are separate routes with a content hash in the URL (cacheable for a year) and an ETag. No inline JavaScript (CSP). |
| Telegram bot | Match-day morning greeting (from 08:00, at least 4 h before throw-off, for chats that want announcements), announcement (lead time per chat), lineup, half-time, final score as an animated card, match report, postponements, season card; commands `/spiele` `/ergebnisse` `/tabelle` `/kader` `/torjaeger` `/spieler` `/saison` `/rekorde` `/bericht` `/live` `/kalender` `/halle` `/erinnerung` `/modus` `/teams` `/feedback`; inline mode; groups; admin chats with `/status`, `/rundruf`, `/erledigt`. **`/teams`** lets every subscriber pick which teams of the club they follow — messages and commands are filtered accordingly. A new chat starts with no team and is asked first (with more than one team configured); chats from before keep following all. |
| Browser push | Subscriptions per team (capped by `SITE_PUSH_MAX`), same events and texts as the bot, dead subscriptions removed on 404/410/403; a win vibrates like a goal celebration. |
| Todoteck API | `/api/overview`, `/api/teams/:id/details`, `/api/teams/:id/bild/:art`, `/api/sync`, `/api/health` — Bearer `API_TOKEN`. |
| Source checks | Concurrent requests for the same path are coalesced, a shared league table is fetched once per run, and the three core responses (season, matches, standings) are shape-checked with zod — a changed format fails loudly (`HandballEmptyError`) instead of producing wrong numbers. `/healthz` reports the state of the fetch (last success, failures, request counters) without error text. |
| Settings page | `/settings` (one admin account from the environment, optionally on its own port): teams, colours, fetch intervals, Telegram switches, microsite texts and switches, a status view, a change log and an `.env` export. See *Settings page*. |
| Operator alerts | Fetch failures (auth immediately, transient from the third run) and a suspected time-zone misreading go to the admin chats once per state. |

## Architecture

```text
 handball.net ──fetch (daily + match day)──▶ ┌────────────────────────────┐
                                             │ Handballteck (Fastify)     │
 Telegram ◀──webhook / sendMessage──────────▶│  SQLite (data/handballteck │
                                             │  .db, WAL)                 │
 Browsers ◀──/<team>/ (HTML, PNG, ICS, RSS)──│  sharp renders SVG → PNG   │
          ◀──Web Push (VAPID)────────────────│  scheduler every 15 min    │
                                             └──────────┬─────────────────┘
 Todoteck ──Bearer API_TOKEN──▶ /api/* ◀────────────────┘
   (cockpit, widget, two notification events)
```

All state is one SQLite file under `DATA_DIR`. Configuration is the environment plus the settings page `/settings`: what is saved there wins over the environment (see *Settings page*).

## Prerequisites

- Node.js 22 (local) or Docker
- A public `https://` address for the Telegram webhook and the microsite
- Optional: a bot token from BotFather, and a Todoteck instance that wants the cockpit

## Installation / Quick start

```bash
cp .env.example .env        # fill in TEAM_IDS, PUBLIC_URL, tokens
docker compose up --build   # http://localhost:3010/ — local development only
```

Production runs the published image `ghcr.io/fauteck/handballteck` (see *Versioning*),
deployed from `docker-configs` like every other stack.

Local development without Docker:

```bash
npm install
npm run dev                 # tsx watch, http://localhost:3000/
npm test
```

### Migrating from Todoteck

The Telegram subscribers, the browser subscriptions and the sent-markers cannot be
re-fetched; they are copied once from the Todoteck database (its tables are called
`legacy_handball_*` after Todoteck's migration 0105, or still `handball_*` before it).
The copy also takes the VAPID key pair from Todoteck's `app_settings` — without it every
browser subscription would silently fail with HTTP 403.

In production the import runs **at startup**, because operations go through Portainer
stacks, not `docker exec`:

1. Mount a Todoteck backup snapshot (or its database file) read-only into the container.
2. Set `IMPORT_TODOTECK_DB` to its path inside the container and redeploy.
3. Read the log (`Übernahme aus Todoteck fertig: …`), then remove the variable.

The import runs **once**: a marker in `settings` makes every later start skip it, so a
chat that sent `/stop` after the move is not re-added. The source is copied to
`DATA_DIR` before reading (a WAL database cannot be opened on a read-only mount) and the
copy is deleted afterwards. Locally, `npm run import:todoteck -- /path/to/familytodo.db`
runs the same import without the marker.

Configuration (team IDs, colours, bot token, microsite switches) does **not** migrate —
it lives in the environment and on the settings page now.

## Reverse proxy setup

The microsite uses relative links only. To serve it under its own domain, proxy the
domain root to this container and set `SITE_URL=https://woelfe.example.de` so that
`webcal://`, the feed and the Open Graph preview point there. Team pages are then
`https://woelfe.example.de/<team-id>/`; the domain root redirects to the first team.
Set `TRUST_PROXY` to the addresses (IP or CIDR, comma separated) of the proxies in front of the service. Empty trusts none: behind a proxy all clients then share one rate-limit bucket, so a single client can lock everyone out of the page; the service logs a warning once when it sees `X-Forwarded-For` without `TRUST_PROXY`. Never trust all: a client could forge its address with `X-Forwarded-For` and bypass every limit. A hop count is not an option — Fastify ≥ 5.12 ignores it and trusts no proxy.

## Settings page

`/settings` edits part of the configuration without a redeploy. It is off until
`ADMIN_PASSWORD` (at least 12 characters) is set; until then every address below it answers 404.

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_USER` | `admin` | Name of the single admin account. |
| `ADMIN_PASSWORD` | – (page off) | Its password, from the environment only. |
| `ADMIN_PORT` | – | Serve `/settings` on its own port instead of the public one (keep that port off the reverse proxy); the public port then no longer answers `/settings`. |

- **Precedence:** the page wins over the environment, the environment over the default. Each
  field shows its source; "Auf die Umgebung zurücksetzen" removes the saved value. A saved
  empty value hides the environment on purpose. Values live in `settings` as `cfg.<NAME>`.
- **On the page:** `TEAM_IDS`, `CLUB_TEAM_IDS`, `CLUB_NAME`, the three colours, `SYNC_INTERVAL_MS`,
  `SYNC_LIVE_INTERVAL_MS`, `TELEGRAM_INVITE_CODE`, `TELEGRAM_ADMIN_CHAT_IDS`, `BOT_AUTO_DESCRIPTION`,
  `SITE_ENABLED`, `SITE_PLAYERS`, `SITE_PUSH_MAX`, `SITE_URL`, `SITE_OPERATOR`, `SITE_FEEDBACK_MAIL`,
  `SITE_PREVIEW_TOKEN`, `CLUBDESK_URL`, `CLUBDESK_TEAMS`.
- **Environment only:** `PUBLIC_URL`, `PORT`, `TRUST_PROXY`, `DATA_DIR`, `DATABASE_PATH`, `SQLITE_JOURNAL_MODE`,
  `LOG_LEVEL`, `IMPORT_TODOTECK_DB`, `TELEGRAM_BOT_TOKEN`, `API_TOKEN`, `VAPID_*` and the `ADMIN_*` account.
  The page only shows whether the secrets are set. The bot token already runs through the same lookup, so
  moving it onto the page later is a registry entry, not a rewrite.
- **Applying:** most values act immediately. Teams, club name and ClubDesk start a fetch; the intervals apply
  from the next tick. Every change is logged in `settings_audit` (secrets masked). "Als .env exportieren"
  gives the effective values without secrets, to copy into `docker-configs`.
- **Security:** one session in memory (8 h, lost on restart), cookie `HttpOnly; SameSite=Strict; Path=/settings`
  (`Secure` on https), JSON-only writes with `X-CSRF-Token` and an Origin check, login limited to 5 per minute and
  per address, constant-time comparison, `no-store`, `noindex`, no inline JavaScript. A forgotten password or
  a wrong value is repaired in the environment: remove `ADMIN_PASSWORD`/change it and redeploy; saved values
  are reset on the page or by deleting the `cfg.*` rows.

## Configuration

See `.env.example` for every variable with its default. Values saved on the settings page override these. The important ones:

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | External address of this service (webhook, page links). |
| `TEAM_IDS` | – | Team IDs from handball.net, comma separated, optionally `id=Name`. Without a name the team switcher derives one from league and team name (`1. Herren`, `mB-Jugend`). The page groups the teams in two levels — Herren · Frauen · Jungen · Mädchen on top, the teams of that group below — from the competition (or the name given here: `wC-Jugend`, `2. Damen`). |
| `CLUB_TEAM_IDS` | – | Team IDs that handball.net still lists under their original club but that belong to the club in fact: shown everywhere (page, images, bot, API) as `CLUB_NAME`. A trailing Roman numeral of the source name (`… II`) is kept. |
| `CLUB_NAME` | `HSG Wölfe Voreifel` | The name used for `CLUB_TEAM_IDS`. |
| `PRIMARY_COLOR` / `SECONDARY_COLOR` / `ACCENT_COLOR` | club default | Palette of images and page, `#rrggbb`. |
| `SYNC_INTERVAL_MS` | `900000` | Tick of the scheduler, minimum 5 min. |
| `SYNC_LIVE_INTERVAL_MS` | `60000` | Tick while a match is live (min 20 s, `0` = off); also polls from 5 minutes before kick-off instead of kick-off + 45 min. Each tick stores score, game clock and the latest goals; the page replaces „Nächstes Spiel“ by a live view and reloads itself every 30 s. |
| `SITE_PUSH_MAX` | `2000` | Maximum number of browser push subscriptions; the subscribe route answers 503 above it. |
| `TELEGRAM_BOT_TOKEN` | – | Enables the bot. |
| `TELEGRAM_INVITE_CODE` | – | Restricts `/start` to invitees. |
| `TELEGRAM_ADMIN_CHAT_IDS` | – | Operator chats (status, broadcast, feedback, alerts). |
| `BOT_AUTO_DESCRIPTION` | `true` | Keep the bot's profile texts in sync with standings and next match. |
| `SITE_ENABLED` | `true` | Serve the microsite. |
| `SITE_PLAYERS` | `false` | Show player names (youth teams!). |
| `SITE_URL` | – | Root under which a proxy serves the pages. |
| `SITE_OPERATOR` / `SITE_FEEDBACK_MAIL` | – | Footer of the microsite. |
| `SITE_PREVIEW_TOKEN` | – (off) | Secret (≥ 32 chars) for `/<team>/?vorab=<token>`: the page then also shows what is not public yet (ClubDesk photos). Responses are `private, no-store`; the token is masked in logs. |
| `CLUBDESK_URL` / `CLUBDESK_TEAMS` | – | Club website on ClubDesk and team-id → team-page mapping (`75796=woelfe_1`). Daily fetch of the group photo (youth only with `SITE_PLAYERS`) and, for senior teams, the squad portraits; stored downscaled as JPEG. Shown only in the preview. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | generated | Web push keys; generated and stored on first use. |
| `API_TOKEN` | – | Bearer token for `/api/*`; unset means 401 for all of it. |
| `DATA_DIR` / `DATABASE_PATH` | `./data` | Where the SQLite file lives. |
| `TRUST_PROXY` | – | Proxy addresses (IP/CIDR list) whose `X-Forwarded-For` is trusted. |
| `IMPORT_TODOTECK_DB` | – | One-time import from a Todoteck database at startup. |

## API reference

| Route | Auth | Purpose |
|---|---|---|
| `/settings`, `/settings/settings.js`, `/settings/vorschau`, `/settings/api/*` | admin session | Settings page (login, state, save, sync, `.env` export, redirect to the secret preview). 404 without `ADMIN_PASSWORD`. |
| `GET /healthz` | none | Liveness, version, fetch state (`sync`: last success, failures, counters — no error text). |
| `GET /`, `GET /uebersicht/`, `GET /:teamId/…` | none | Microsite (HTML, match pages `spiel/:matchId`, overview `uebersicht/`, `app.js`, `sw.js`, manifest, logo, fonts, `bild/*.png`, `feed.xml`, `kalender.ics`, `push`). 404 while `SITE_ENABLED=false`. |
| `POST /telegram/webhook/:secret` | path + header secret | Telegram updates. |
| `GET /inline/:art.jpg` | HMAC signature in URL | Images for the bot's inline mode. |
| `GET /api/overview` | Bearer | Teams, matches, standings, bot and site summary — the shape Todoteck's cockpit consumes. Additive since the two-level switcher: `teams[].group` (`herren`/`frauen`/`jungen`/`maedchen`/`null`), `matches[].is_live` and `matches[].live`. |
| `GET /api/teams/:id/details` | Bearer | Season lines, records, players, available images. |
| `GET /api/teams/:id/bild/:art` | Bearer | PNG: `tabelle`, `kader`, `spiel`, `endstand?match=`, `verlauf`, `torjaeger`, `saison`, `spieler/:playerId`. |
| `POST /api/sync` | Bearer | Force a fetch, then push to bot and site. |
| `GET /api/health` | Bearer | Fetch/bot/site health for Todoteck's service row. |

## Database schema

Tables keep their Todoteck names (`handball_team_match`, `handball_standings`,
`handball_bot_*`, `handball_roster`, `handball_match_player`, `handball_match_change`,
`handball_team_logo`, `handball_site_subscription`, `handball_opponent_form`) so the
import is one-to-one, plus `settings` (VAPID keys, `cfg.*` values of the settings page), `settings_audit` (its change log) and `handball_bot_subscriber.team_ids`
(the per-chat team selection). Migrations are the SQL files in `drizzle/`, applied once
each and recorded in `migrations`.

## Security aspects

- Visitors need no account and get no cookie. Two protected surfaces: `/api/*` (Bearer token,
  constant-time compare, closed entirely without `API_TOKEN`) and `/settings` (admin account from the
  environment, session cookie, CSRF protection; absent without `ADMIN_PASSWORD`, optionally on its own `ADMIN_PORT`).
- The webhook checks a random path and Telegram's secret header; inline images carry a
  signed, expiring URL. Rate limits on every public route.
- Web Push only goes to the browsers' push services (FCM, Mozilla, WNS, Apple); any
  other endpoint is refused at subscription and dropped at delivery — the server never
  sends to an address a visitor chose.
- Request logs show `/telegram/webhook/***` and `t=***` instead of the secrets.
- CSP forbids inline scripts; the page's script is a separate route. Logos are fetched
  through `safeFetch` with a host allowlist and stored locally, never hot-linked.
- Player names of youth teams are shown only with `SITE_PLAYERS=true`.
- Security headers on every response: CSP (scripts only from `'self'`), `nosniff`, `Referrer-Policy: no-referrer`, HSTS, COOP, `Permissions-Policy`. `security.test.ts` pins them and fails for any route that has neither its own rate limit nor a listed reason.
- The `quality` job runs `npm audit` (runtime, high+) and Trivy (lockfile vulnerabilities and committed secrets).
- The page is `noindex` and `robots.txt` disallows everything: it is for sharing, not for finding.

## Technology stack

Node 22 · TypeScript · Fastify 5 (`@fastify/helmet`, `@fastify/rate-limit`) · better-sqlite3 + drizzle-orm ·
sharp (SVG → PNG/JPEG/GIF) · web-push · zod · vitest · esbuild.

## Project structure

```text
src/
  index.ts            entry: migrations, server, bot registration, scheduler
  server.ts           Fastify instance, CSP, rate limit, route registration
  config.ts           everything from the environment (plus saved values of the settings page)
  db/                 connection, drizzle schema, migration runner
  routes/             site.ts (microsite), telegram.ts (webhook, inline), api.ts (Todoteck), settings.ts (/settings)
  import/             todoteck.ts (one-time import at startup)
  lib/                handballNetClient, handballTeam (fetch + DB),
                      handballBot (core: config, subscribers, handler, rounds),
                      handballBotTexts (pure texts + keyboards), handballBotImages (SVG),
                      handballTableImage (SVG renderer), handballSite (HTML),
                      handballSiteAssets (CSS, service worker, page script), handballSitePush,
                      settingsRegistry/settingsStore/settingsPage (settings page),
                      telegramClient, webPush, safeFetch, alerts, …
  __tests__/          vitest
drizzle/              SQL migrations
scripts/              build.js, import-todoteck.ts (local import)
assets/fonts/         Barlow, Barlow Condensed (OFL)
```

## Development

```bash
npm run dev          # watch mode
npm run typecheck
npm test             # vitest, sequential (shared SQLite per file)
npm run build        # dist/
```

## Versioning

Images are built only by the manual workflow **Publish Docker Image**
(`.github/workflows/publish.yml`, `workflow_dispatch`). Its `quality` job runs
typecheck and tests; the image job needs it and pushes
`ghcr.io/fauteck/handballteck:latest` plus the short commit SHA. `gates_only = true`
runs the checks without publishing. No git tags, no releases.

## License

MIT (`LICENSE`); the Barlow fonts are under the SIL Open Font License
(`assets/fonts/OFL.txt`). Data comes from handball.net's undocumented internal API — there
is no contract; a change there is reported to the admin chats, not prevented.
