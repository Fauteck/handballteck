# Handballteck

![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![Fastify](https://img.shields.io/badge/fastify-5-black) ![SQLite](https://img.shields.io/badge/sqlite-better--sqlite3-blue) ![License](https://img.shields.io/badge/license-MIT-lightgrey)

Follow the handball teams of one club from [handball.net](https://www.handball.net): a public
microsite in the club's colours, a Telegram bot, browser push, a calendar subscription
and an RSS feed — in one container, without an account for anyone who just wants to
know when the next match is. A small token-protected API feeds the Todoteck cockpit.

This service was carved out of [Todoteck](https://github.com/Fauteck/todo) on
2026-09-28; `docs/handball-verfolgung.md` there tells the story and the reasoning
behind every feature (§8 covers the split). Todoteck keeps a cockpit that reads this
service's `/api/*`.

## Feature overview

| Feature | What it does |
|---|---|
| Fetch | Once per calendar day: season, schedule, standings (with per-matchday history), roster, logos, opponent form. On match day: follow-up from throw-off + 45 min until the final score, then the standings once. Backfill of lineups, logos, event lists and match reports in small batches per tick. |
| Microsite | `/<team-id>/` — next match with opponent profile, last result, standings with trend arrows, schedule with match timelines, season chart, squad (names only with `SITE_PLAYERS`). A dropdown at the top switches between all teams of the club. Push bell, `webcal://` subscription, RSS feed, share button, PWA manifest. No inline JavaScript (CSP). |
| Telegram bot | Announcement (lead time per chat), lineup, half-time, final score as an animated card, match report, postponements, season card; commands `/spiele` `/ergebnisse` `/tabelle` `/kader` `/torjaeger` `/spieler` `/saison` `/rekorde` `/bericht` `/live` `/kalender` `/halle` `/erinnerung` `/modus` `/teams` `/feedback`; inline mode; groups; admin chats with `/status`, `/rundruf`, `/erledigt`. **`/teams`** lets every subscriber pick which teams of the club they follow — messages and commands are filtered accordingly. A new chat starts with no team and is asked first (with more than one team configured); chats from before keep following all. |
| Browser push | Subscriptions per team, same events and texts as the bot, dead subscriptions removed on 404/410/403. |
| Todoteck API | `/api/overview`, `/api/teams/:id/details`, `/api/teams/:id/bild/:art`, `/api/sync`, `/api/health` — Bearer `API_TOKEN`. |
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

All state is one SQLite file under `DATA_DIR`. Configuration is environment only; there is
no settings UI.

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
it lives in the environment now.

## Reverse proxy setup

The microsite uses relative links only. To serve it under its own domain, proxy the
domain root to this container and set `SITE_URL=https://woelfe.example.de` so that
`webcal://`, the feed and the Open Graph preview point there. Team pages are then
`https://woelfe.example.de/<team-id>/`; the domain root redirects to the first team.
Set `TRUST_PROXY` to the addresses (IP or CIDR, comma separated) of the proxies in front of the service. Empty trusts none: all clients then share one rate-limit bucket — annoying, not a hole. Never trust all: a client could forge its address with `X-Forwarded-For` and bypass every limit. A hop count is not an option — Fastify ≥ 5.12 ignores it and trusts no proxy.

## Configuration

See `.env.example` for every variable with its default. The important ones:

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | External address of this service (webhook, page links). |
| `TEAM_IDS` | – | Team IDs from handball.net, comma separated, optionally `id=Name`. Without a name the dropdown derives one from league and team name (`1. Herren`, `mB-Jugend`). |
| `PRIMARY_COLOR` / `SECONDARY_COLOR` / `ACCENT_COLOR` | club default | Palette of images and page, `#rrggbb`. |
| `SYNC_INTERVAL_MS` | `900000` | Tick of the scheduler, minimum 5 min. |
| `TELEGRAM_BOT_TOKEN` | – | Enables the bot. |
| `TELEGRAM_INVITE_CODE` | – | Restricts `/start` to invitees. |
| `TELEGRAM_ADMIN_CHAT_IDS` | – | Operator chats (status, broadcast, feedback, alerts). |
| `BOT_AUTO_DESCRIPTION` | `true` | Keep the bot's profile texts in sync with standings and next match. |
| `SITE_ENABLED` | `true` | Serve the microsite. |
| `SITE_PLAYERS` | `false` | Show player names (youth teams!). |
| `SITE_URL` | – | Root under which a proxy serves the pages. |
| `SITE_OPERATOR` / `SITE_FEEDBACK_MAIL` | – | Footer of the microsite. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | generated | Web push keys; generated and stored on first use. |
| `API_TOKEN` | – | Bearer token for `/api/*`; unset means 401 for all of it. |
| `DATA_DIR` / `DATABASE_PATH` | `./data` | Where the SQLite file lives. |
| `TRUST_PROXY` | – | Proxy addresses (IP/CIDR list) whose `X-Forwarded-For` is trusted. |
| `IMPORT_TODOTECK_DB` | – | One-time import from a Todoteck database at startup. |

## API reference

| Route | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | Liveness, version. |
| `GET /`, `GET /:teamId/…` | none | Microsite (HTML, `app.js`, `sw.js`, manifest, logo, fonts, `bild/*.png`, `feed.xml`, `kalender.ics`, `push`). 404 while `SITE_ENABLED=false`. |
| `POST /telegram/webhook/:secret` | path + header secret | Telegram updates. |
| `GET /inline/:art.jpg` | HMAC signature in URL | Images for the bot's inline mode. |
| `GET /api/overview` | Bearer | Teams, matches, standings, bot and site summary — the shape Todoteck's cockpit consumes. |
| `GET /api/teams/:id/details` | Bearer | Season lines, records, players, available images. |
| `GET /api/teams/:id/bild/:art` | Bearer | PNG: `tabelle`, `kader`, `spiel`, `endstand?match=`, `verlauf`, `torjaeger`, `saison`, `spieler/:playerId`. |
| `POST /api/sync` | Bearer | Force a fetch, then push to bot and site. |
| `GET /api/health` | Bearer | Fetch/bot/site health for Todoteck's service row. |

## Database schema

Tables keep their Todoteck names (`handball_team_match`, `handball_standings`,
`handball_bot_*`, `handball_roster`, `handball_match_player`, `handball_match_change`,
`handball_team_logo`, `handball_site_subscription`, `handball_opponent_form`) so the
import is one-to-one, plus `settings` (VAPID keys) and `handball_bot_subscriber.team_ids`
(the per-chat team selection). Migrations are the SQL files in `drizzle/`, applied once
each and recorded in `migrations`.

## Security aspects

- No accounts, no cookies. The only protected surface is `/api/*` (Bearer token,
  constant-time compare) — and it is closed entirely without `API_TOKEN`.
- The webhook checks a random path and Telegram's secret header; inline images carry a
  signed, expiring URL. Rate limits on every public route.
- CSP forbids inline scripts; the page's script is a separate route. Logos are fetched
  through `safeFetch` with a host allowlist and stored locally, never hot-linked.
- Player names of youth teams are shown only with `SITE_PLAYERS=true`.
- The page is `noindex` and `robots.txt` disallows everything: it is for sharing, not for finding.

## Technology stack

Node 22 · TypeScript · Fastify 5 (`@fastify/helmet`, `@fastify/rate-limit`) · better-sqlite3 + drizzle-orm ·
sharp (SVG → PNG/JPEG/GIF) · web-push · zod · vitest · esbuild.

## Project structure

```text
src/
  index.ts            entry: migrations, server, bot registration, scheduler
  server.ts           Fastify instance, CSP, rate limit, route registration
  config.ts           everything from the environment
  db/                 connection, drizzle schema, migration runner
  routes/             site.ts (microsite), telegram.ts (webhook, inline), api.ts (Todoteck)
  import/             todoteck.ts (one-time import at startup)
  lib/                handballNetClient, handballTeam (fetch + DB), handballBot,
                      handballTableImage (SVG), handballSite (HTML), handballSitePush,
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
