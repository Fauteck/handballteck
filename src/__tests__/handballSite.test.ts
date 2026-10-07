import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { unlinkSync } from 'fs';
import type { PushPayload, PushResult, PushTarget } from '../lib/webPush';

/**
 * Die Handball-Microsite (Wiki „Handball-Verfolgung (handball.net)“ §7): die öffentliche
 * Mannschaftsseite und ihre Web-Push-Anmeldung ohne Konto.
 *
 * Geprüft wird, was den offenen Zugang vertretbar macht — 404 ohne Freigabe,
 * Spielernamen nur mit zweitem Schalter — und dass die Seite mit allem
 * Zubehör (Skript, Service Worker, Manifest, Bilder, Feed, Kalender)
 * antwortet. Dazu der Versand: Endstand an die Browser-Abonnenten genau
 * einmal, tote Subscriptions fliegen.
 */

const DB_FILE = `/tmp/handball-site-${process.pid}.db`;
process.env.DATABASE_PATH = DB_FILE;
process.env.PUBLIC_URL = 'https://todo.test.local';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_INVITE_CODE;
delete process.env.TELEGRAM_ADMIN_CHAT_IDS;
delete process.env.TEAM_IDS;
delete process.env.PRIMARY_COLOR; delete process.env.SECONDARY_COLOR; delete process.env.ACCENT_COLOR;
delete process.env.SITE_URL; delete process.env.SITE_PLAYERS; delete process.env.SITE_ENABLED;
delete process.env.SITE_OPERATOR; delete process.env.SITE_FEEDBACK_MAIL;

const sendPush = vi.fn();
vi.mock('../lib/webPush', () => ({
  sendPush: (...args: unknown[]) => sendPush(...args),
  isPushConfigured: () => true,
  getVapidPublicKey: () => 'BTestVapidKey',
}));

const TEAM = '96254';

describe('Handball-Microsite', () => {
  let fastify: FastifyInstance;
  let db: typeof import('../db/index')['db'];
  let schema: typeof import('../db/schema');
  let eq: typeof import('drizzle-orm')['eq'];
  let sitePush: typeof import('../lib/handballSitePush');

  /** Die Schalter der Microsite kommen aus der Umgebung; die alten Feldnamen bleiben als Lesehilfe. */
  const setConfig = (config: Record<string, string>) => {
    process.env.TEAM_IDS = config.team_ids ?? TEAM;
    process.env.SITE_ENABLED = config.site_enabled ?? 'false';
    process.env.SITE_PLAYERS = config.site_players ?? 'false';
    if (config.site_url) process.env.SITE_URL = config.site_url; else delete process.env.SITE_URL;
  };

  beforeAll(async () => {
    ({ db } = await import('../db/index'));
    schema = await import('../db/schema');
    ({ eq } = await import('drizzle-orm'));
    const { runMigrations } = await import('../db/migrate');
    const { siteRoutes } = await import('../routes/site');
    sitePush = await import('../lib/handballSitePush');
    runMigrations();
    process.env.SITE_OPERATOR = 'Niklas Fauteck';
    process.env.SITE_FEEDBACK_MAIL = 'info@fauteck.eu';

    const now = new Date().toISOString();
    const spiel = (id: string, startsAt: string, status: string, home: number | null, away: number | null, heim = true) => ({
      id: `${TEAM}:${id}`, team_id: TEAM, match_id: id, season_id: 2627, starts_at: startsAt, status, status_name: status, round: 3, phase_id: 12800,
      competition_name: 'Kreisoberliga mB', championship_name: 'B-Jugend',
      home_id: heim ? TEAM : '96300', home_name: heim ? 'HSG Wölfe Voreifel' : 'HV Erftstadt', away_id: heim ? '96300' : TEAM, away_name: heim ? 'HV Erftstadt' : 'HSG Wölfe Voreifel',
      score_home: home, score_away: away, venue_name: 'Sporthalle Heimerzheim', venue_address: 'Schulstraße 1, 53913 Swisttal',
      notified_upcoming: false, notified_result: false, updated_at: now,
    });
    db.insert(schema.handball_team_match).values([
      spiel('m1', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(), 'finished', 30, 22),
      // Frisch beendet: Der Endstand muss an die Abonnenten gehen.
      spiel('m2', new Date(Date.now() - 90 * 60 * 1000).toISOString(), 'finished', 25, 20, false),
      spiel('m3', new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), 'scheduled', null, null),
    ] as never).run();
    db.insert(schema.handball_standings).values({
      phase_id: 12800, season_id: 2627, competition_name: 'Kreisoberliga mB', fetched_at: now,
      payload: JSON.stringify([
        { round: 2, position: 1, teamId: TEAM, teamName: 'HSG Wölfe Voreifel', played: 2, won: 1, drawn: 0, lost: 1, goalsFor: 55, goalsAgainst: 47, goalsDiff: 8, points: 2 },
        { round: 2, position: 2, teamId: '96300', teamName: 'HV Erftstadt', played: 2, won: 1, drawn: 0, lost: 1, goalsFor: 47, goalsAgainst: 55, goalsDiff: -8, points: 2 },
      ]),
    }).run();

    fastify = Fastify();
    await fastify.register(siteRoutes);
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    try { unlinkSync(DB_FILE); } catch { /* egal */ }
  });

  beforeEach(() => {
    sendPush.mockReset();
    sendPush.mockResolvedValue({ status: 'sent' });
    setConfig({ site_enabled: 'true' });
  });

  const get = (url: string) => fastify.inject({ method: 'GET', url });

  it('antwortet ohne Freigabe für alles mit 404', async () => {
    setConfig({});
    for (const url of [`/${TEAM}`, `/${TEAM}/`, `/${TEAM}/feed.xml`, `/${TEAM}/push`, `/${TEAM}/bild/spiel.png`]) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
    expect((await fastify.inject({ method: 'POST', url: `/${TEAM}/push`, payload: {} })).statusCode).toBe(404);
  });

  it('kennt nur eingetragene Mannschaften', async () => {
    expect((await get('/12345/')).statusCode).toBe(404);
    expect((await get('/abc/')).statusCode).toBe(404);
  });

  it('leitet ohne Schrägstrich auf die Adresse mit um', async () => {
    const res = await get(`/${TEAM}`);
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe(`${TEAM}/`);
  });

  it('liefert die Seite im Vereins-CD mit relativen Verweisen und noindex', async () => {
    const res = await get(`/${TEAM}/`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    const html = res.body;
    expect(html).toContain('HSG Wölfe Voreifel');
    expect(html).toContain('HV Erftstadt');
    expect(html).toMatch(/<script src="\.\/app\.js\?v=[0-9a-f]{10}" defer><\/script>/);
    expect(html).toMatch(/<link rel="stylesheet" href="\.\/site\.css\?v=[0-9a-f]{10}">/);
    expect(html).not.toContain('<style>');
    expect(html).toContain('./bild/spiel.png');
    expect(html).toContain('./bild/endstand.png?match=m2');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('webcal://todo.test.local/96254/kalender.ics');
    expect((await get(`/${TEAM}/site.css`)).body).toContain('--p:#003e51');
    // Kein Inline-Skript (CSP), kein Todoteck.
    expect(html).not.toMatch(/<script>/);
    expect(html).not.toContain('Todoteck');
    // Zwei Spalten ab 960 px: das Spiel links, die Wege und der Spielplan rechts; am Telefon eine Reihenfolge über `order`.
    expect(html).toContain('<div class="col main">');
    expect(html).toContain('<div class="col side">');
    expect(html).toContain('class="card dark s-push"');
    expect(html).toContain('class="card s-plan"');
    // Kennzahlen im Kopf: Platz von N, Punkte, Bilanz, Tore, nächstes Spiel in Tagen.
    expect(html).toContain('<b class="a">1.<small>von 2</small></b><span>Platz</span>');
    expect(html).toContain('<b>1-0-1</b>');
    expect(html).toContain('In 7 Tagen');
    // Die Wege: Kalender-Abo und Feed als Kacheln, kein Telegram, solange kein Bot registriert ist.
    expect(html).toContain('<b>Kalender-Abo</b>');
    expect(html).toContain('<b>RSS-Feed</b>');
    expect(html).not.toContain('data-share');
    expect(html).not.toContain('t.me/');
    // Footer: wer die Seite baut und wohin Rückmeldungen gehen.
    expect(html).toContain('nicht-kommerzielles Projekt von Niklas Fauteck');
    expect(html).toContain('<a href="mailto:info@fauteck.eu">info@fauteck.eu</a>');
    // Spielernamen sind aus: keine Torjäger, kein Kader, keine Saisonkarte.
    expect(html).not.toContain('torjaeger.png');
    expect(html).not.toContain('kader.png');
    expect(html).not.toContain('saison.png');
  });

  it('zeigt Tendenzpfeile gegenüber dem vorigen Spieltag, sobald der Verlauf da ist', async () => {
    const z = (round: number, position: number, teamId: string) => ({
      round, position, teamId, teamName: teamId === TEAM ? 'HSG Wölfe Voreifel' : 'HV Erftstadt', played: round, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalsDiff: 0, points: 0,
    });
    // Nach dem 1. Spieltag standen die Wölfe auf 2, jetzt (2. Spieltag) auf 1.
    db.update(schema.handball_standings).set({ history_payload: JSON.stringify([z(1, 1, '96300'), z(1, 2, TEAM), z(2, 1, TEAM), z(2, 2, '96300')]) })
      .where(eq(schema.handball_standings.phase_id, 12800)).run();
    try {
      const html = (await get(`/${TEAM}/`)).body;
      expect(html).toContain('<i class="up" title="von Platz 2 auf 1 geklettert">▲</i>');
      expect(html).toContain('<i class="down" title="von Platz 1 auf 2 gerutscht">▼</i>');
      expect(html).toContain('▲▼ gegenüber dem Stand nach dem 1. Spieltag');
    } finally {
      db.update(schema.handball_standings).set({ history_payload: null }).where(eq(schema.handball_standings.phase_id, 12800)).run();
    }
  });

  it('zeigt Gegner-Steckbrief, Spielverlauf und — nur mit Schalter — den Spielbericht', async () => {
    const now = new Date().toISOString();
    // Der Tageslauf hat den Spielplan des Gegners geholt: zwei Ergebnisse, eines gegen uns.
    db.insert(schema.handball_opponent_form).values({
      team_id: '96300', season_id: 2627, fetched_at: now,
      payload: JSON.stringify([
        { id: 'g1', seasonId: 2627, startsAt: new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString(), status: 'finished', statusName: 'Finalizado', round: 1, phaseId: 12800, competitionName: 'Kreisoberliga mB', championshipName: 'B-Jugend', homeId: '96300', homeName: 'HV Erftstadt', awayId: '96301', awayName: 'TV Palmersheim II', scoreHome: 31, scoreAway: 20, venueName: null, venueAddress: null, venueLat: null, venueLon: null, reportUrl: null, homeLogoUrl: null, awayLogoUrl: null },
        { id: 'm1', seasonId: 2627, startsAt: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(), status: 'finished', statusName: 'Finalizado', round: 2, phaseId: 12800, competitionName: 'Kreisoberliga mB', championshipName: 'B-Jugend', homeId: TEAM, homeName: 'HSG Wölfe Voreifel', awayId: '96300', awayName: 'HV Erftstadt', scoreHome: 30, scoreAway: 22, venueName: null, venueAddress: null, venueLat: null, venueLon: null, reportUrl: null, homeLogoUrl: null, awayLogoUrl: null },
      ]),
    }).run();
    // Torfolge und Bericht am letzten Spiel (m2, auswärts 20:25 verloren).
    db.update(schema.handball_team_match).set({
      events_payload: JSON.stringify([
        { minute: 2, home: 1, away: 0, goal: true, block: '1. Halbzeit' },
        { minute: 4, home: 1, away: 1, goal: true, block: '1. Halbzeit' },
        { minute: 6, home: 1, away: 1, goal: false, block: '1. Halbzeit' },
        { minute: 40, home: 25, away: 20, goal: true, block: '2. Halbzeit' },
      ]),
      halftime_home: 12, halftime_away: 10,
      report_text: '## Erste Halbzeit\n\nEskil Lieck traf siebenmal.',
    }).where(eq(schema.handball_team_match.id, `${TEAM}:m2`)).run();
    try {
      let html = (await get(`/${TEAM}/`)).body;
      // Steckbrief: Tabellenzeile, letzte Ergebnisse des Gegners (ohne das anstehende Spiel), Direktvergleich aus den eigenen Spielen.
      expect(html).toContain('<div class="gegner">');
      expect(html).toContain('2. Platz · 1-0-1 · 47:55 Tore · 2 Pkt');
      expect(html).toContain('22:30 bei HSG Wölfe Voreifel · 31:20 gegen TV Palmersheim II');
      expect(html).toContain('<span class="lbl">Bisher</span><span class="res">30:22 (H) · 20:25 (A)</span>');
      // Spielverlauf ohne Namen: immer; der Bericht nennt Spieler: nur mit dem zweiten Schalter.
      expect(html).toContain('<summary>Spielverlauf</summary>');
      expect(html).toContain('aria-label="Spielverlauf: Führung je Spielminute"');
      expect(html).toContain('HZ 10:12');
      expect(html).toContain('<b>1:1</b> (4.)');
      expect(html).not.toContain('Eskil Lieck traf');
      setConfig({ site_enabled: 'true', site_players: 'true' });
      html = (await get(`/${TEAM}/`)).body;
      expect(html).toContain('<summary>Spielverlauf & Spielbericht</summary>');
      expect(html).toContain('<h4>Erste Halbzeit</h4><p>Eskil Lieck traf siebenmal.</p>');
      // Überall zugeklappt, auch unter dem letzten Spiel.
      expect(html).toContain('<details class="more"><summary>Spielverlauf & Spielbericht</summary>');
      expect(html).not.toContain('<details class="more" open>');
    } finally {
      db.delete(schema.handball_opponent_form).run();
      db.update(schema.handball_team_match).set({ events_payload: null, report_text: null, halftime_home: null, halftime_away: null }).where(eq(schema.handball_team_match.id, `${TEAM}:m2`)).run();
    }
  });

  it('nimmt SITE_URL als Wurzel für webcal und Open Graph', async () => {
    setConfig({ site_enabled: 'true', site_url: 'https://woelfe.example.de' });
    const html = (await get(`/${TEAM}/`)).body;
    expect(html).toContain('webcal://woelfe.example.de/96254/kalender.ics');
    expect(html).toContain('<meta property="og:url" content="https://woelfe.example.de/96254/">');
    expect(html).toContain('<meta property="og:image" content="https://woelfe.example.de/96254/bild/spiel.png">');
  });

  it('zeigt bei mehreren Mannschaften Schaltflächen mit relativen Zielen, die Wurzel führt zur ersten', async () => {
    expect((await get(`/${TEAM}/`)).body).not.toContain('class="teamwahl"');
    setConfig({ site_enabled: 'true', team_ids: '96254=B-Jugend,96300=C-Jugend' });
    db.insert(schema.handball_team_match).values({
      id: '96300:c1', team_id: '96300', match_id: 'c1', season_id: 2627, starts_at: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
      status: 'scheduled', status_name: 'scheduled', round: 1, phase_id: 12900, competition_name: 'Kreisliga mC', championship_name: 'C-Jugend',
      home_id: '96300', home_name: 'HSG Wölfe Voreifel', away_id: '96400', away_name: 'TV Palmersheim',
      score_home: null, score_away: null, venue_name: null, venue_address: null, notified_upcoming: false, notified_result: false, updated_at: new Date().toISOString(),
    } as never).run();
    try {
      const html = (await get(`/${TEAM}/`)).body;
      expect(html).toContain('<a href="../96254/" aria-current="page">B-Jugend</a>');
      expect(html).toContain('<a href="../96300/">C-Jugend</a>');
      expect((await get('/96300/')).statusCode).toBe(200);
      const wurzel = await get('/');
      expect(wurzel.statusCode).toBe(302);
      expect(wurzel.headers.location).toBe('96254/');
    } finally {
      db.delete(schema.handball_team_match).where(eq(schema.handball_team_match.team_id, '96300')).run();
    }
  });

  it('liefert Stil und Skript mit ETag und, bei passendem Hash, dauerhaft zwischenspeicherbar', async () => {
    const html = (await get(`/${TEAM}/`)).body;
    const cssUrl = /href="\.\/(site\.css\?v=[0-9a-f]{10})"/.exec(html)![1];
    const css = await get(`/${TEAM}/${cssUrl}`);
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    expect(css.headers['cache-control']).toContain('immutable');
    expect(css.body).toContain('--p:#003e51');
    const etag = String(css.headers.etag);
    const nochmal = await fastify.inject({ method: 'GET', url: `/${TEAM}/${cssUrl}`, headers: { 'if-none-match': etag } });
    expect(nochmal.statusCode).toBe(304);
    // Ein komprimierender Proxy schickt das ETag schwach zurück, auch in einer Liste.
    const schwach = await fastify.inject({ method: 'GET', url: `/${TEAM}/${cssUrl}`, headers: { 'if-none-match': `"alt", W/${etag}` } });
    expect(schwach.statusCode).toBe(304);
    // Ohne oder mit falschem Hash: kurze Frist, kein immutable.
    expect((await get(`/${TEAM}/site.css`)).headers['cache-control']).not.toContain('immutable');
    const js = await get(`/${TEAM}/app.js?v=falsch`);
    expect(js.headers['cache-control']).not.toContain('immutable');
  });

  it('baut die Bedienung der Seite ein: Kacheln mit Schlüssel, Countdown, Spielplan-Filter, Überspringen', async () => {
    const html = (await get(`/${TEAM}/`)).body;
    expect(html).toContain('<details class="channel push" data-key="browser">');
    expect(html).toContain('data-key="kalender"');
    expect(html).toContain('data-key="rss"');
    expect(html).toContain('data-aktiv hidden');
    expect(html).toMatch(/data-countdown="\d{4}-\d\d-\d\dT/);
    expect(html).toContain('data-filter-bar');
    expect(html).toContain('data-filter="heim"');
    expect(html).toContain('data-jump');
    expect(html).toMatch(/<li[^>]* data-ha="(heim|aus)" data-st="(gespielt|kommend)">/);
    expect(html).toContain('<a class="skip" href="#inhalt">');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).not.toContain('data-live');
  });

  it('hält die Seite offline vor und liefert ein installierbares Manifest', async () => {
    const sw = await get(`/${TEAM}/sw.js`);
    expect(sw.body).toContain("addEventListener('fetch'");
    expect(sw.body).toContain('if (payload.vibrate) options.vibrate');
    expect(sw.body).toContain('ignoreSearch: true');
    const manifest = (await get(`/${TEAM}/manifest.webmanifest`)).json();
    expect(manifest.id).toBe('./');
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(['192x192', '512x512']);
    expect(manifest.shortcuts.map((x: { url: string }) => x.url)).toEqual(['./#naechstes', './#tabelle', './#spielplan']);
    const klein = await get(`/${TEAM}/logo-192.png`);
    expect(klein.statusCode).toBe(200);
    expect(klein.headers['content-type']).toBe('image/png');
    const app = await get(`/${TEAM}/app.js`);
    expect(app.body).toContain('data-live');
    expect(app.body).toContain('handball-site-open');
  });

  it('zeigt den Live-Modus nur bei laufendem Spiel — und lässt die Seite dann nur kurz liegen', async () => {
    const id = `${TEAM}:m3`;
    db.update(schema.handball_team_match).set({ status: 'live', score_home: 3, score_away: 2 }).where(eq(schema.handball_team_match.id, id)).run();
    try {
      const res = await get(`/${TEAM}/`);
      expect(res.body).toContain('<body data-live="1">');
      expect(res.headers['cache-control']).toBe('public, max-age=15');
    } finally {
      db.update(schema.handball_team_match).set({ status: 'scheduled', score_home: null, score_away: null }).where(eq(schema.handball_team_match.id, id)).run();
    }
    const ruhig = await get(`/${TEAM}/`);
    expect(ruhig.body).not.toContain('data-live');
    expect(ruhig.headers['cache-control']).toBe('public, max-age=60');
  });

  it('zeichnet den Torverlauf der besten Schützen — nur mit Spielernamen', async () => {
    const jetzt = new Date().toISOString();
    const zeile = (matchId: string, playerId: string, nummer: number, tore: number) => ({
      id: `${TEAM}:${matchId}:${playerId}`, team_id: TEAM, match_id: matchId, player_id: playerId, number: nummer, goals: tore, updated_at: jetzt,
    });
    db.insert(schema.handball_match_player).values([
      zeile('m1', 'p1', 7, 9), zeile('m2', 'p1', 7, 4), zeile('m1', 'p2', 11, 3), zeile('m2', 'p2', 11, 6),
    ] as never).run();
    try {
      expect((await get(`/${TEAM}/`)).body).not.toContain('Tore im Saisonverlauf');
      setConfig({ site_enabled: 'true', site_players: 'true' });
      const html = (await get(`/${TEAM}/`)).body;
      expect(html).toContain('Tore im Saisonverlauf');
      expect(html).toContain('aria-label="Tore der besten Torschützen je Spiel, aufsummiert"');
      expect(html).toContain('<li><i style="background:var(--ad)"></i>Nr. 7 <b>13</b></li>');
      expect(html).toContain('Nr. 11 <b>9</b>');
    } finally {
      db.delete(schema.handball_match_player).run();
    }
  });

  describe('Vorschau mit Fotos der Vereinsseite', () => {
    const TOKEN = 'v'.repeat(40);
    const SENIOR = '96301';
    let jpeg: Buffer;

    beforeAll(async () => {
      const sharp = (await import('sharp')).default;
      jpeg = await sharp({ create: { width: 8, height: 10, channels: 3, background: '#336699' } }).jpeg().toBuffer();
      const jetzt = new Date().toISOString();
      const foto = (team: string, kind: string, contact: string | null, name: string, section: string | null, sort: number) => ({
        id: kind === 'gruppe' ? `${team}:gruppe` : `${team}:person:${contact}`, team_id: team, kind, contact_id: contact, name, section, position: kind === 'person' ? 'Rückraum' : null,
        sort, source_key: 'x', image: jpeg, fetched_at: jetzt,
      });
      db.insert(schema.clubdesk_photo).values([
        foto(TEAM, 'gruppe', null, 'B-Jugend', null, 0),
        foto(TEAM, 'person', '7001', 'Jugendlicher', 'Spieler(in)', 1),
        foto(SENIOR, 'gruppe', null, 'Wölfe I', null, 0),
        foto(SENIOR, 'person', '8001', 'Senior Eins', 'Spieler(in)', 1),
      ] as never).run();
      db.insert(schema.handball_team_match).values({
        id: `${SENIOR}:s1`, team_id: SENIOR, match_id: 's1', season_id: 2627, starts_at: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
        status: 'scheduled', status_name: 'scheduled', round: 1, phase_id: 13000, competition_name: 'Oberliga Männer', championship_name: 'Männer',
        home_id: SENIOR, home_name: 'HSG Wölfe Voreifel', away_id: '96400', away_name: 'TV Palmersheim',
        score_home: null, score_away: null, venue_name: null, venue_address: null, notified_upcoming: false, notified_result: false, updated_at: jetzt,
      } as never).run();
    });

    afterAll(() => {
      db.delete(schema.clubdesk_photo).run();
      db.delete(schema.handball_team_match).where(eq(schema.handball_team_match.team_id, SENIOR)).run();
      delete process.env.SITE_PREVIEW_TOKEN;
    });

    beforeEach(() => {
      process.env.SITE_PREVIEW_TOKEN = TOKEN;
      setConfig({ site_enabled: 'true', team_ids: `${TEAM},${SENIOR}` });
    });

    it('zeigt ohne oder mit falschem Schlüssel nichts davon — und die Fotos antworten 404', async () => {
      for (const url of [`/${SENIOR}/`, `/${SENIOR}/?vorab=falsch`, `/${SENIOR}/?vorab=${'x'.repeat(40)}`]) {
        const res = await get(url);
        expect(res.body, url).not.toContain('Das Team');
        expect(res.body, url).not.toContain('vorschau-band');
        expect(res.headers['cache-control'], url).toBe('public, max-age=60');
      }
      expect((await get(`/${SENIOR}/foto/gruppe.jpg`)).statusCode).toBe(404);
      expect((await get(`/${SENIOR}/foto/gruppe.jpg?vorab=falsch`)).statusCode).toBe(404);
      // Ein zu kurzer Schlüssel in der Umgebung schaltet die Vorschau gar nicht erst ein.
      process.env.SITE_PREVIEW_TOKEN = 'kurz';
      expect((await get(`/${SENIOR}/?vorab=kurz`)).body).not.toContain('Das Team');
    });

    it('zeigt mit Schlüssel Gruppenbild und Porträts der Senioren — privat, nicht zwischenspeicherbar', async () => {
      setConfig({ site_enabled: 'true', team_ids: `${TEAM},${SENIOR}`, site_players: 'true' });
      const res = await get(`/${SENIOR}/?vorab=${TOKEN}`);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.body).toContain('class="vorschau-band"');
      expect(res.body).toContain(`<img class="bild" src="./foto/gruppe.jpg?vorab=${TOKEN}"`);
      expect(res.body).toContain(`<img src="./foto/8001.jpg?vorab=${TOKEN}"`);
      expect(res.body).toContain('<b>Senior Eins</b><span>Rückraum</span>');
      // Die Mannschaftswahl trägt den Schlüssel weiter.
      expect(res.body).toContain(`href="../96254/?vorab=${TOKEN}"`);
      const bild = await get(`/${SENIOR}/foto/gruppe.jpg?vorab=${TOKEN}`);
      expect(bild.statusCode).toBe(200);
      expect(bild.headers['content-type']).toBe('image/jpeg');
      expect(bild.headers['cache-control']).toBe('private, max-age=3600');
      expect((await get(`/${SENIOR}/foto/8001.jpg?vorab=${TOKEN}`)).statusCode).toBe(200);
      // Eine Kontakt-ID einer anderen Mannschaft gibt es hier nicht.
      expect((await get(`/${SENIOR}/foto/7001.jpg?vorab=${TOKEN}`)).statusCode).toBe(404);
      expect((await get(`/${SENIOR}/foto/..%2Fgruppe.jpg?vorab=${TOKEN}`)).statusCode).toBe(404);
    });

    it('zeigt Porträts der Senioren nur mit Spielernamen, das Gruppenbild auch ohne', async () => {
      const html = (await get(`/${SENIOR}/?vorab=${TOKEN}`)).body;
      expect(html).toContain('./foto/gruppe.jpg');
      expect(html).not.toContain('./foto/8001.jpg');
      expect((await get(`/${SENIOR}/foto/8001.jpg?vorab=${TOKEN}`)).statusCode).toBe(404);
    });

    it('zeigt bei der Jugend das Gruppenbild nur mit Spielernamen und nie Porträts', async () => {
      let html = (await get(`/${TEAM}/?vorab=${TOKEN}`)).body;
      expect(html).not.toContain('Das Team');
      expect((await get(`/${TEAM}/foto/gruppe.jpg?vorab=${TOKEN}`)).statusCode).toBe(404);
      setConfig({ site_enabled: 'true', team_ids: `${TEAM},${SENIOR}`, site_players: 'true' });
      html = (await get(`/${TEAM}/?vorab=${TOKEN}`)).body;
      expect(html).toContain('./foto/gruppe.jpg');
      expect(html).not.toContain('./foto/7001.jpg');
      expect((await get(`/${TEAM}/foto/7001.jpg?vorab=${TOKEN}`)).statusCode).toBe(404);
    });
  });

  it('bietet einen Schalter für hell und dunkel — gesetzt vor dem Zeichnen, ohne Inline-Skript', async () => {
    const html = (await get(`/${TEAM}/`)).body;
    expect(html).toContain('data-theme-toggle hidden');
    expect(html).toMatch(/<script src="\.\/theme\.js\?v=[0-9a-f]{10}"><\/script>\n<link rel="stylesheet"/);
    const theme = await get(`/${TEAM}/theme.js`);
    expect(theme.statusCode).toBe(200);
    expect(theme.body).toContain("localStorage.getItem('handball-site-theme')");
    const css = (await get(`/${TEAM}/site.css`)).body;
    expect(css).toContain(':root[data-theme=dark]{--bg:#0c1a1f');
    expect(css).toContain('@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0c1a1f');
    expect(css).toContain(':root[data-theme=dark] .btn{background:#12262c');
    expect((await get(`/${TEAM}/app.js`)).body).toContain("themeWahl === 'auto' ? 'light'");
  });

  it('zeigt Spielernamen nur mit dem zweiten Schalter — auch bei den Bildern', async () => {
    expect((await get(`/${TEAM}/bild/torjaeger.png`)).statusCode).toBe(404);
    setConfig({ site_enabled: 'true', site_players: 'true' });
    // Ohne gespeicherte Aufstellung gibt es kein Torjäger-Bild — aber die Route kennt es jetzt (404 mit Auskunft statt „gibt es nicht").
    const res = await get(`/${TEAM}/bild/torjaeger.png`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('no_image');
  });

  it('liefert Skript, Service Worker, Manifest, Logo und Schrift', async () => {
    const app = await get(`/${TEAM}/app.js`);
    expect(app.statusCode).toBe(200);
    expect(app.headers['content-type']).toContain('javascript');
    expect(app.body).toContain("register('./sw.js', { scope: './' })");
    const sw = await get(`/${TEAM}/sw.js`);
    expect(sw.statusCode).toBe(200);
    expect(sw.body).toContain("addEventListener('push'");
    const manifest = await get(`/${TEAM}/manifest.webmanifest`);
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json()).toMatchObject({ name: 'HSG Wölfe Voreifel', start_url: './', display: 'standalone', theme_color: '#003e51' });
    const logo = await get(`/${TEAM}/logo.png`);
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
    const font = await get(`/${TEAM}/fonts/Barlow-Regular.ttf`);
    expect([200, 404]).toContain(font.statusCode);
    expect((await get(`/${TEAM}/fonts/../../etc/passwd`)).statusCode).toBe(404);
  });

  it('rendert die Bilder als PNG und nimmt sie beim zweiten Mal aus dem Cache', async () => {
    const eins = await get(`/${TEAM}/bild/spiel.png`);
    expect(eins.statusCode).toBe(200);
    expect(eins.headers['content-type']).toBe('image/png');
    expect(eins.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    const zwei = await get(`/${TEAM}/bild/spiel.png`);
    expect(zwei.rawPayload.equals(eins.rawPayload)).toBe(true);
    expect((await get(`/${TEAM}/bild/endstand.png?match=m1`)).statusCode).toBe(200);
    expect((await get(`/${TEAM}/bild/tabelle.png`)).statusCode).toBe(200);
    expect((await get(`/${TEAM}/bild/irgendwas.png`)).statusCode).toBe(404);
  });

  it('liefert Feed und Kalender', async () => {
    const feed = await get(`/${TEAM}/feed.xml`);
    expect(feed.statusCode).toBe(200);
    expect(feed.headers['content-type']).toContain('rss+xml');
    expect(feed.body).toContain('<rss version="2.0"');
    expect(feed.body).toContain('HSG Wölfe Voreifel gewinnt 30:22 gegen HV Erftstadt');
    expect(feed.body).toContain('HSG Wölfe Voreifel verliert 20:25 bei HV Erftstadt');
    expect(feed.body).toContain('Nächstes Spiel: HSG Wölfe Voreifel gegen HV Erftstadt');
    const ics = await get(`/${TEAM}/kalender.ics`);
    expect(ics.statusCode).toBe(200);
    expect(ics.headers['content-type']).toContain('text/calendar');
    expect(ics.body).toContain('BEGIN:VCALENDAR');
    expect(ics.body).toContain('UID:handball-m3@todoteck');
  });

  describe('Web-Push ohne Konto', () => {
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p'.repeat(32), auth: 'a'.repeat(16) } };
    const post = (payload: Record<string, unknown>) => fastify.inject({ method: 'POST', url: `/${TEAM}/push`, payload });
    const deps = { send: (t: PushTarget, p: PushPayload): Promise<PushResult> => sendPush(t, p) as Promise<PushResult> };

    it('nennt den VAPID-Schlüssel', async () => {
      const res = await get(`/${TEAM}/push`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ enabled: true, public_key: 'BTestVapidKey' });
    });

    it('trägt eine Subscription ein, bestätigt per Push und erneuert statt zu verdoppeln', async () => {
      const res = await post({ subscription: sub, lead: '3h', mode: 'all' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, lead: '3h', mode: 'all' });
      await new Promise(r => setTimeout(r, 10));
      expect(sendPush).toHaveBeenCalledTimes(1);
      expect(sendPush.mock.calls[0][0]).toMatchObject({ endpoint: sub.endpoint });
      expect(sendPush.mock.calls[0][1].title).toContain('Benachrichtigungen an');

      const zwei = await post({ subscription: sub, lead: 'aus', mode: 'results' });
      expect(zwei.json()).toEqual({ ok: true, lead: 'aus', mode: 'results' });
      const zeilen = sitePush.listSiteSubscribers(TEAM);
      expect(zeilen).toHaveLength(1);
      expect(zeilen[0]).toMatchObject({ lead: 'aus', mode: 'results' });
    });

    it('weist Unvollständiges und http-Endpoints ab', async () => {
      expect((await post({})).statusCode).toBe(400);
      expect((await post({ subscription: { endpoint: 'http://push.example/x', keys: sub.keys } })).statusCode).toBe(400);
      // SEC-1-001: Nur die Push-Dienste der Browser — kein internes Ziel, kein fremder Host.
      for (const endpoint of [
        'https://192.168.1.10/x', 'https://router.fritz.box/x', 'https://push.example/x',
        'https://fcm.googleapis.com:8443/x', 'https://fcm.googleapis.com.evil.example/x', 'https://evilpush.apple.com/x',
      ]) {
        expect((await post({ subscription: { endpoint, keys: sub.keys } })).statusCode, endpoint).toBe(400);
      }
      for (const endpoint of ['https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-db5p.notify.windows.com/w/?token=x', 'https://web.push.apple.com/x']) {
        expect((await post({ subscription: { endpoint, keys: sub.keys } })).statusCode, endpoint).toBe(200);
        await fastify.inject({ method: 'DELETE', url: `/${TEAM}/push`, payload: { endpoint } });
      }
      // Unbekannter Vorlauf fällt auf den Standard zurück statt abzulehnen.
      const res = await post({ subscription: { ...sub, endpoint: 'https://fcm.googleapis.com/fcm/send/def' }, lead: 'sofort', mode: 'egal' });
      expect(res.json()).toEqual({ ok: true, lead: '1h', mode: 'all' });
    });

    it('nimmt über der Obergrenze keine neue Anmeldung mehr an — wer drin ist, darf ändern', async () => {
      // Unabhängig von der Reihenfolge der Tests und ohne den Bestand anzufassen:
      // `sub` steht drin, und die Grenze liegt genau beim jetzigen Stand.
      sitePush.saveSiteSubscription(TEAM, { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, lead: '1h', mode: 'all' });
      process.env.SITE_PUSH_MAX = String(sitePush.countSiteSubscribers());
      try {
        const neu = await post({ subscription: { ...sub, endpoint: 'https://fcm.googleapis.com/fcm/send/voll' }, lead: '1h', mode: 'all' });
        expect(neu.statusCode).toBe(503);
        expect(neu.json().error).toBe('push_full');
        expect(neu.headers['retry-after']).toBe('3600');
        expect((await post({ subscription: sub, lead: '1h', mode: 'all' })).statusCode).toBe(200);
      } finally {
        delete process.env.SITE_PUSH_MAX;
      }
    });

    it('trägt wieder aus', async () => {
      const res = await fastify.inject({ method: 'DELETE', url: `/${TEAM}/push`, payload: { endpoint: 'https://fcm.googleapis.com/fcm/send/def' } });
      expect(res.json()).toEqual({ ok: true, removed: 1 });
      expect(sitePush.listSiteSubscribers(TEAM).map(s => s.endpoint)).toEqual([sub.endpoint]);
    });

    it('schickt den frischen Endstand genau einmal — und löscht tote Abonnenten', async () => {
      sitePush.resetSiteSent();
      // Der Abonnent von oben will nur Ergebnisse; ein zweiter alles.
      sitePush.saveSiteSubscription(TEAM, { endpoint: 'https://fcm.googleapis.com/fcm/send/tot', p256dh: 'p'.repeat(32), auth: 'a'.repeat(16), lead: '1h', mode: 'all' });
      sendPush.mockImplementation(async (target: { endpoint: string }) => (target.endpoint.endsWith('/tot') ? { status: 'gone', reason: 'HTTP 410' } : { status: 'sent' }));

      const r = await sitePush.pushHandballSite(new Date(), deps);
      // Ein Endstand (m2, 90 Minuten alt) an beide; m1 ist eine Woche alt und wird nur gemerkt.
      expect(r.messages).toBe(1);
      expect(r.recipients).toBe(1);
      const payloads = sendPush.mock.calls.map(c => c[1] as { title: string; image?: string; tag?: string; vibrate?: number[] });
      expect(payloads).toHaveLength(2);
      expect(payloads[0].title).toContain('HSG Wölfe Voreifel verliert 20:25');
      expect(payloads[0].image).toBe('bild/endstand.png?match=m2');
      expect(payloads[0].tag).toBe('handball-m2');
      // Eine Niederlage vibriert einmal lang, nicht wie ein Torjubel.
      expect(payloads[0].vibrate).toEqual([400]);
      expect(sitePush.listSiteSubscribers(TEAM).map(s => s.endpoint)).toEqual([sub.endpoint]);

      sendPush.mockClear();
      const nochmal = await sitePush.pushHandballSite(new Date(), deps);
      expect(nochmal.messages).toBe(0);
      expect(sendPush).not.toHaveBeenCalled();
    });

    it('schweigt bei abgeschalteter Microsite', async () => {
      setConfig({});
      sitePush.resetSiteSent();
      const r = await sitePush.pushHandballSite(new Date(), deps);
      expect(r.messages).toBe(0);
      expect(sendPush).not.toHaveBeenCalled();
    });
  });
});
