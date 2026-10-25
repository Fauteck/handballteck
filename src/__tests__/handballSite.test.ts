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
delete process.env.SITE_URL; delete process.env.SITE_ENABLED;
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
  let sql: typeof import('drizzle-orm')['sql'];
  let sitePush: typeof import('../lib/handballSitePush');

  /** Die Schalter der Microsite kommen aus der Umgebung; die alten Feldnamen bleiben als Lesehilfe. */
  const setConfig = (config: Record<string, string>) => {
    process.env.TEAM_IDS = config.team_ids ?? TEAM;
    process.env.SITE_ENABLED = config.site_enabled ?? 'false';
    if (config.site_url) process.env.SITE_URL = config.site_url; else delete process.env.SITE_URL;
    if (config.site_photos) process.env.SITE_PHOTOS = config.site_photos; else delete process.env.SITE_PHOTOS;
  };

  beforeAll(async () => {
    ({ db } = await import('../db/index'));
    schema = await import('../db/schema');
    ({ eq, sql } = await import('drizzle-orm'));
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
    expect(html).not.toContain('s-push');
    expect(html).toContain('class="card s-plan"');
    // Drei Kennzahlen im Kopf: Platz von N, Form, nächstes Spiel. Punkte, Bilanz und Tore stehen in der Tabellenkarte.
    expect(html).toContain('<b class="a">1.<small>von 2</small></b><span>Platz</span>');
    expect(html.match(/<div class="stat">/g)).toHaveLength(3);
    expect(html).toContain('<div><dt>Siege · Unent. · Niederl.</dt><dd>1-0-1</dd></div>');
    expect(html).toContain('<div><dt>Punkte</dt><dd>2:2<small>2 Sp.</small></dd></div>');
    expect(html).toContain('In 7 Tagen');
    // Die Wege: Icons im Kopf unter „Team-Infos nicht verpassen" (Glocke, Kalender, Feed), kein Telegram, solange kein Bot registriert ist.
    expect(html).toContain('id="verpassen-titel">Team-Infos nicht verpassen</span>');
    expect(html).toContain('aria-label="Kalender abonnieren"');
    expect(html).toContain('aria-label="RSS-Feed-Adresse kopieren"');
    expect(html).toContain('<dialog class="popup" id="push"');
    // Als App installieren: Der Knopf zeigt sich erst mit Skript und öffnet im iFrame die volle Seite in einem eigenen Tab.
    expect(html).toContain('<a class="vicon" href="./?installieren=1" target="_blank" rel="noopener" data-install title="mB-Jugend als App installieren" aria-label="mB-Jugend als App installieren" hidden>');
    expect(html).toContain('<h2 id="installieren-titel">mB-Jugend als App installieren</h2>');
    // Jede Mannschaft ist eine eigene App mit ihrem Namen auf dem Startbildschirm.
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="mB-Jugend">');
    expect(html).toContain('<dialog class="popup" id="installieren"');
    expect(html).toContain('„Zum Home-Bildschirm“ wählen.');
    expect(html.indexOf('class="verpassen"')).toBeLessThan(html.indexOf('<main'));
    expect(html).not.toContain('data-share');
    expect(html).not.toContain('t.me/');
    // Footer: wer die Seite baut und wohin Rückmeldungen gehen.
    expect(html).toContain('nicht-kommerzielles Projekt von Niklas Fauteck');
    expect(html).toContain('<a href="mailto:info@fauteck.eu">info@fauteck.eu</a>');
    // Spielernamen stehen immer da: die Saisonkarte ja; Torjäger und Kader erst, wenn es Tore und einen Kader gibt.
    expect(html).toContain('saison.png');
    expect(html).not.toContain('torjaeger.png');
    expect(html).not.toContain('kader.png');
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

  it('zeigt Gegner-Steckbrief und Spielverlauf — den Text des Spielberichts nicht', async () => {
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
      expect(html).toContain('2. Platz · 1-0-1 · 47:55 Tore · 2:2 Punkte');
      expect(html).toContain('30:22 bei HSG Wölfe Voreifel · 31:20 gegen TV Palmersheim II');
      expect(html).toContain('<span class="lbl">Bisher</span><span class="res">30:22 (H) · 25:20 (A)</span>');
      // Spielverlauf ohne Namen: immer; der Text des Spielberichts steht nie auf der Seite.
      expect(html).toContain('<summary>Spielverlauf</summary>');
      expect(html).toContain('aria-label="Spielverlauf: Führung je Spielminute"');
      expect(html).toContain('HZ 12:10');
      expect(html).toContain('<b>1:1</b> (4.)');
      expect(html).not.toContain('Eskil Lieck traf');
      setConfig({ site_enabled: 'true' });
      html = (await get(`/${TEAM}/`)).body;
      expect(html).not.toContain('Eskil Lieck traf');
      expect(html).not.toContain('Spielbericht</summary>');
      // Überall zugeklappt, auch unter dem letzten Spiel.
      expect(html).toContain('<details class="more"><summary>Spielverlauf</summary>');
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
      expect(html).toContain('<li><a href="../96300/">C-Jugend</a></li>');
      expect((await get('/96300/')).statusCode).toBe(200);
      const wurzel = await get('/');
      expect(wurzel.statusCode).toBe(200);
      // Kopf wie auf der Mannschaftsseite: Vereinsname oben, dann die Kästen, darunter der Titel.
      expect(wurzel.body).toContain('<div class="verein"><a class="heim titel" href="./"><span class="kicker">HSG Wölfe Voreifel</span></a></div>');
      expect(wurzel.body).toContain('<div class="teaminfo">\n    <h1>Wölfe live - Handball im Revier</h1>');
      // Installierbar: Manifest und Service Worker an der Wurzel, Dateien von der ersten Mannschaft.
      expect(wurzel.body).toContain('<link rel="manifest" href="./manifest.webmanifest">');
      expect(wurzel.body).toContain('<meta name="apple-mobile-web-app-title" content="Wölfe live">');
      expect(wurzel.body).toContain('<dialog class="popup" id="installieren"');
      expect(wurzel.body).toContain('href="./?installieren=1"');
      expect(wurzel.body).toContain('id="verpassen-titel">Alle Infos nicht verpassen</span>');
      expect(wurzel.body).toContain('<h2 id="installieren-titel">Wölfe live - Handball im Revier als App installieren</h2>');
      const manifest = await get('/manifest.webmanifest');
      expect(manifest.statusCode).toBe(200);
      expect(manifest.json()).toMatchObject({ name: 'Wölfe live - Handball im Revier', start_url: './', scope: './', display: 'standalone' });
      expect(manifest.json().icons[0].src).toBe('./96254/logo-192.png');
      expect((await get('/sw.js')).headers['content-type']).toContain('javascript');
      // Kopf der Mannschaftsseite: Vereinsname klein darüber, die Mannschaft als Titel.
      const team = (await get(`/${TEAM}/`)).body;
      // Logo und Vereinsname oben (führen zur Startseite), das Team als Text unter der Navigation.
      expect(team).toContain('<div class="verein"><a class="heim titel" href="../"><span class="kicker">HSG Wölfe Voreifel</span></a></div>');
      // Der Vereinsname kommt überall aus der Einstellung, nicht aus dem Teamnamen bei handball.net.
      process.env.CLUB_NAME = 'Wölfe Voreifel';
      try {
        expect((await get('/')).body).toContain('<span class="kicker">Wölfe Voreifel</span>');
        expect((await get(`/${TEAM}/`)).body).toContain('<span class="kicker">Wölfe Voreifel</span>');
        expect((await get(`/${TEAM}/spiel/m1`)).body).toContain('<span class="kicker">Wölfe Voreifel</span>');
        // Auch Browser-Tab, App-Name und Feed.
        expect((await get(`/${TEAM}/`)).body).toContain('<title>Wölfe Voreifel · B-Jugend</title>');
        expect((await get(`/${TEAM}/manifest.webmanifest`)).json()).toMatchObject({ name: 'Wölfe Voreifel B-Jugend', short_name: 'B-Jugend' });
        expect((await get(`/${TEAM}/feed.xml`)).body).toContain('<title>Wölfe Voreifel</title>');
      } finally {
        delete process.env.CLUB_NAME;
      }
      expect(team).toContain('<div class="teaminfo">\n    <h1>B-Jugend</h1>');
      expect(team.indexOf('class="kaesten')).toBeLessThan(team.indexOf('<h1>B-Jugend</h1>'));
      expect(team.indexOf('class="verein"')).toBeLessThan(team.indexOf('class="kaesten'));
      // „Alle" vorne (hier markiert), dann fünf große Bereichskästen; die Mannschaften klappen darunter auf.
      expect(wurzel.body.match(/class="kasten[ "]/g)?.length).toBe(6);
      expect(wurzel.body).toContain('<nav class="kaesten flach" aria-label="Mannschaften nach Bereich"><a class="kasten alle aktiv" href="./" aria-current="page"><span class="kopf"><b>Alle</b>');
      expect(wurzel.body).toContain('<details class="kasten" name="bereich" data-bereich="jungen">');
      expect(wurzel.body).toContain('<li><a href="./96300/">C-Jugend</a></li>');
      expect(wurzel.body).toContain('id="heimspiele"');
      expect(wurzel.body).toContain('href="./96254/site.css?v=');
      expect(wurzel.body).toContain('<a href="./96300/">C-Jugend</a>');
    } finally {
      db.delete(schema.handball_team_match).where(eq(schema.handball_team_match.team_id, '96300')).run();
    }
  });

  it('zeigt auf jeder Seite die Bereichskästen der Startseite, der eigene offen; Titel führt zur Startseite', async () => {
    setConfig({ site_enabled: 'true', team_ids: '96254=B-Jugend,96300=1. Damen,96301=C-Jugend' });
    const zeile = (teamId: string, wettbewerb: string, klasse: string) => ({
      id: `${teamId}:g1`, team_id: teamId, match_id: 'g1', season_id: 2627, starts_at: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
      status: 'scheduled', status_name: 'scheduled', round: 1, phase_id: 12900, competition_name: wettbewerb, championship_name: klasse,
      home_id: teamId, home_name: 'HSG Wölfe Voreifel', away_id: '96400', away_name: 'TV Palmersheim',
      score_home: null, score_away: null, venue_name: null, venue_address: null, notified_upcoming: false, notified_result: false, updated_at: new Date().toISOString(),
    });
    db.insert(schema.handball_team_match).values([zeile('96300', 'Landesliga Frauen', 'Frauen'), zeile('96301', 'Kreisliga mC', 'C-Jugend')] as never).run();
    try {
      const html = (await get(`/${TEAM}/`)).body;
      // Dieselben Kästen wie auf der Startseite; „Alle" führt zurück, der eigene Bereich ist markiert, die eigene Mannschaft auch.
      expect(html.match(/class="kasten[ "]/g)?.length).toBe(6);
      expect(html).toContain('<nav class="kaesten flach" aria-label="Mannschaften nach Bereich"><a class="kasten alle" href="../"><span class="kopf"><b>Alle</b>');
      expect(html).toContain('<nav class="kaesten flach"');
      expect(html).toContain('<details class="kasten aktiv" name="bereich" data-bereich="jungen">');
      expect(html).not.toContain(' open>');
      expect(html).toContain('<li><a href="../96254/" aria-current="page">B-Jugend</a></li><li><a href="../96301/">C-Jugend</a></li>');
      expect(html).toContain('<details class="kasten" name="bereich" data-bereich="frauen">');
      expect(html).toContain('<li><a href="../96300/">1. Damen</a></li>');
      expect(html).toContain('<div class="kasten leer" aria-disabled="true"><span class="kopf"><b>Kinder</b>');
      // Titel und Vereinsname führen zur Startseite; auf der Spielseite eine Ebene höher.
      expect(html).toContain('<a class="heim titel" href="../"><span class="kicker">HSG Wölfe Voreifel</span></a>');
      expect((await get(`/${TEAM}/spiel/m1`)).body).toContain('<a class="heim titel" href="../../">');
      expect((await get(`/${TEAM}/spiel/m1`)).body).toContain('<li><a href="../../96300/">1. Damen</a></li>');
      expect((await get(`/${TEAM}/spiel/m1`)).body).toContain('<a class="kasten alle" href="../../">');
      // Die Vorschau trägt ihren Schlüssel in jeden Verweis.
      process.env.SITE_PREVIEW_TOKEN = 'p'.repeat(40);
      const vorschau = (await get(`/${TEAM}/?vorab=${'p'.repeat(40)}`)).body;
      expect(vorschau).toContain(`<a href="../96301/?vorab=${'p'.repeat(40)}">C-Jugend</a>`);
      expect(vorschau).toContain(`<a class="heim titel" href="../?vorab=${'p'.repeat(40)}">`);
      expect(vorschau).toContain(`<a class="kasten alle" href="../?vorab=${'p'.repeat(40)}">`);
      delete process.env.SITE_PREVIEW_TOKEN;
    } finally {
      db.delete(schema.handball_team_match).where(eq(schema.handball_team_match.team_id, '96300')).run();
      db.delete(schema.handball_team_match).where(eq(schema.handball_team_match.team_id, '96301')).run();
    }
  });

  it('zeigt während des Spiels die Live-Ansicht statt „Nächstes Spiel" — auch, solange die Quelle noch „angesetzt" sagt', async () => {
    const id = `${TEAM}:m3`;
    const vor = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    db.update(schema.handball_team_match).set({
      starts_at: vor,
      live_payload: JSON.stringify({
        fetched_at: new Date().toISOString(), home: 7, away: 5, minute: '19:40', block: '1. Halbzeit', halftime: null,
        items: [{ minute: 18.2, home: 6, away: 5, goal: true, block: '1. Halbzeit' }, { minute: 19.6, home: 7, away: 5, goal: true, block: '1. Halbzeit' }],
      }),
    }).where(eq(schema.handball_team_match.id, id)).run();
    try {
      const res = await get(`/${TEAM}/`);
      expect(res.body).toContain('<body data-live="1">');
      // Die Startseite zeigt das laufende Spiel ganz oben und lädt sich selbst nach (data-live).
      const start = await get('/');
      expect(start.body).toContain('<body data-live="1">');
      expect(start.body.indexOf('id="live"')).toBeLessThan(start.body.indexOf('id="heimspiele"'));
      expect(start.headers['cache-control']).toBe('public, max-age=15');
      expect(res.body).toContain('Läuft gerade');
      expect(res.body).toContain('class="tore-gross">7:5<');
      expect(res.body).toContain('19:40 Min. · 1. Halbzeit');
      expect(res.body).toContain('aria-label="Letzte Tore"');
      expect(res.body).not.toContain('<h2>Nächstes Spiel');
      expect(res.headers['cache-control']).toBe('public, max-age=15');
    } finally {
      db.update(schema.handball_team_match).set({ starts_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), live_payload: null }).where(eq(schema.handball_team_match.id, id)).run();
    }
    expect((await get(`/${TEAM}/`)).body).toContain('<h2>Nächstes Spiel');
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

  it('baut Übersicht und Seite nur neu, wenn sich etwas ändert — sonst 304 für den Live-Poll (PRF-1-002)', async () => {
    const { handballOverview, seitenUebersicht } = await import('../lib/handballSicht');
    // Ohne Schreiben und ohne neue Konfiguration: dasselbe, eingefrorene Objekt.
    const a = handballOverview();
    expect(handballOverview()).toBe(a);
    expect(Object.isFrozen(a.teams[0].matches)).toBe(true);
    expect(seitenUebersicht()).toBe(seitenUebersicht());

    const erste = await get(`/${TEAM}/`);
    const etag = String(erste.headers.etag);
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    const nochmal = await fastify.inject({ method: 'GET', url: `/${TEAM}/`, headers: { 'if-none-match': etag } });
    expect(nochmal.statusCode).toBe(304);
    expect(nochmal.body).toBe('');

    // Ein geschriebener Wert macht Übersicht und Seite neu — der alte Stand passt nicht mehr.
    db.update(schema.handball_team_match).set({ venue_name: 'Halle am Rathaus' }).where(eq(schema.handball_team_match.match_id, 'm3')).run();
    try {
      expect(handballOverview()).not.toBe(a);
      const neu = await fastify.inject({ method: 'GET', url: `/${TEAM}/`, headers: { 'if-none-match': etag } });
      expect(neu.statusCode).toBe(200);
      expect(neu.body).toContain('Halle am Rathaus');
      expect(neu.headers.etag).not.toBe(etag);
    } finally {
      db.update(schema.handball_team_match).set({ venue_name: 'Sporthalle Heimerzheim' }).where(eq(schema.handball_team_match.match_id, 'm3')).run();
    }

    // Eine geänderte Konfiguration ebenso, ohne dass die Datenbank geschrieben wird.
    const b = handballOverview();
    process.env.CLUB_NAME = 'TV Test';
    try {
      expect(handballOverview()).not.toBe(b);
    } finally {
      delete process.env.CLUB_NAME;
    }

    // Die Vorschau bekommt kein ETag und landet nicht im Zwischenspeicher.
    process.env.SITE_PREVIEW_TOKEN = 'v'.repeat(32);
    try {
      const vorab = await get(`/${TEAM}/?vorab=${'v'.repeat(32)}`);
      expect(vorab.statusCode).toBe(200);
      expect(vorab.headers.etag).toBeUndefined();
    } finally {
      delete process.env.SITE_PREVIEW_TOKEN;
    }
  });

  it('lässt den Live-Poll einer ganzen Halle hinter einer Adresse durch — und drosselt trotzdem (PRF-3-004)', async () => {
    const rateLimit = (await import('@fastify/rate-limit')).default;
    const { siteRoutes } = await import('../routes/site');
    const mitLimit = Fastify();
    await mitLimit.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
    await mitLimit.register(siteRoutes);
    await mitLimit.ready();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 120; i++) codes.push((await mitLimit.inject({ method: 'GET', url: `/${TEAM}/`, remoteAddress: '203.0.113.7' })).statusCode);
      expect(codes.filter(c => c === 429)).toHaveLength(0);
      for (let i = 120; i < 300; i++) await mitLimit.inject({ method: 'GET', url: `/${TEAM}/`, remoteAddress: '203.0.113.7' });
      expect((await mitLimit.inject({ method: 'GET', url: `/${TEAM}/`, remoteAddress: '203.0.113.7' })).statusCode).toBe(429);
    } finally {
      await mitLimit.close();
    }
  });

  it('liefert Skript, Stil und Schriften ohne die Übersicht — und nur für eingetragene Mannschaften', async () => {
    expect((await get(`/${TEAM}/app.js`)).statusCode).toBe(200);
    expect((await get('/12345/app.js')).statusCode).toBe(404);
    expect((await get('/12345/site.css')).statusCode).toBe(404);
    expect((await get('/12345')).statusCode).toBe(404);
    setConfig({});
    expect((await get(`/${TEAM}/app.js`)).statusCode).toBe(404);
  });

  it('baut die Bedienung der Seite ein: Kacheln mit Schlüssel, Countdown, Spielplan-Filter, Überspringen', async () => {
    const html = (await get(`/${TEAM}/`)).body;
    expect(html).toContain('data-dialog-open="push"');
    expect(html).toContain('data-copy="');
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
    expect(app.body).not.toContain('handball-site-open');
    expect(app.body).toContain('button[data-copy]');
    // Installieren: Angebot des Browsers abfangen, im iFrame nur verlinken, ?installieren=1 öffnet das Fenster.
    expect(app.body).toContain("addEventListener('beforeinstallprompt'");
    expect(app.body).toContain('window.top !== window.self');
    expect(app.body).toContain("searchParams.get('installieren') === '1'");
    // Der Kompaktmodus wandert nicht in den Install-Link: Die installierte App zeigt die volle Ansicht.
    expect(app.body).toContain("a.hasAttribute('data-install')");
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

  it('zeigt die Kadergrafik im Abschnitt „Team" — nur mit Spielernamen', async () => {
    db.insert(schema.handball_roster).values({ id: `${TEAM}:p1`, team_id: TEAM, player_id: 'p1', first_name: 'Erika', last_name: 'Muster', number: 7, role: 'player', season_id: 2627, updated_at: new Date().toISOString() }).run();
    try {
      const html = (await get(`/${TEAM}/`)).body;
      expect(html).toContain('<li><a href="#team">Team</a></li>');
      const team = html.slice(html.indexOf('id="team"'));
      expect(team).toContain('<h2>Team</h2>');
      expect(team.slice(0, team.indexOf('</section>'))).toContain('./bild/kader.png');
      // Ohne Fotos kein Bildnachweis der Vereinsseite.
      expect(team.slice(0, team.indexOf('</section>'))).not.toContain('ClubDesk');
    } finally {
      db.delete(schema.handball_roster).run();
    }
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
      const html = (await get(`/${TEAM}/`)).body;
      expect(html).toContain('Tore im Saisonverlauf');
      expect(html).toContain('aria-label="Tore der besten Torschützen je Spiel, aufsummiert"');
      expect(html).toContain('<li><i style="background:var(--ad)"></i>Nr. 7 <b>13</b></li>');
      expect(html).toContain('Nr. 11 <b>9</b>');
      // Chips heißen wie die Überschriften; Torverlauf und Torjäger stehen unter „Statistiken".
      expect(html).toContain('<li><a href="#statistiken">Statistiken</a></li>');
      const statistiken = html.slice(html.indexOf('id="statistiken"'));
      expect(statistiken).toContain('<h2>Statistiken</h2>');
      expect(statistiken.indexOf('Tore im Saisonverlauf')).toBeLessThan(statistiken.indexOf('./bild/torjaeger.png'));
      expect(html).not.toContain('id="mannschaft"');
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
        expect(res.body, url).not.toContain('id="team"');
        expect(res.body, url).not.toContain('vorschau-band');
        expect(res.headers['cache-control'], url).toBe('public, max-age=60');
      }
      expect((await get(`/${SENIOR}/foto/gruppe.jpg`)).statusCode).toBe(404);
      expect((await get(`/${SENIOR}/foto/gruppe.jpg?vorab=falsch`)).statusCode).toBe(404);
      // Ein zu kurzer Schlüssel in der Umgebung schaltet die Vorschau gar nicht erst ein.
      process.env.SITE_PREVIEW_TOKEN = 'kurz';
      expect((await get(`/${SENIOR}/?vorab=kurz`)).body).not.toContain('id="team"');
    });

    it('zeigt mit Schlüssel Gruppenbild und Porträts der Senioren — privat, nicht zwischenspeicherbar', async () => {
      setConfig({ site_enabled: 'true', team_ids: `${TEAM},${SENIOR}` });
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

    it('zeigt bei der Jugend in der Vorschau, was der Abruf vorhält — er holt Jugendbilder nur mit Freigabe', async () => {
      const html = (await get(`/${TEAM}/?vorab=${TOKEN}`)).body;
      expect(html).toContain('./foto/gruppe.jpg');
      // Porträts der Jugend liegen nur vor, wenn sie freigegeben sind (der Abruf holt sie sonst nicht).
      expect(html).toContain(`./foto/7001.jpg?vorab=${TOKEN}`);
      expect((await get(`/${TEAM}/foto/7001.jpg?vorab=${TOKEN}`)).statusCode).toBe(200);
    });

    it('zeigt öffentlich nur, was je Mannschaft freigegeben ist (SITE_PHOTOS) — ohne Vorschau-Band, zwischenspeicherbar', async () => {
      // Senioren: Gruppenbild und Porträts freigegeben; die Jugend nur das Gruppenbild.
      setConfig({ site_enabled: 'true', team_ids: `${TEAM},${SENIOR}`, site_photos: `${SENIOR}=mannschaft+spieler,${TEAM}=mannschaft` });
      const senior = await get(`/${SENIOR}/`);
      expect(senior.headers['cache-control']).toBe('public, max-age=60');
      expect(senior.body).not.toContain('vorschau-band');
      expect(senior.body).toContain('<h2>Team</h2>');
      expect(senior.body).toContain('<img class="bild" src="./foto/gruppe.jpg"');
      expect(senior.body).toContain('<img src="./foto/8001.jpg"');
      expect(senior.body).toContain('<b>Senior Eins</b>');
      const bild = await get(`/${SENIOR}/foto/gruppe.jpg`);
      expect(bild.statusCode).toBe(200);
      expect(bild.headers['cache-control']).toBe('public, max-age=3600');
      expect((await get(`/${SENIOR}/foto/8001.jpg`)).statusCode).toBe(200);
      // Jugend mit nur dem Mannschaftsbild: keine Porträts.
      expect((await get(`/${TEAM}/`)).body).not.toContain('./foto/7001.jpg');
      expect((await get(`/${TEAM}/foto/7001.jpg`)).statusCode).toBe(404);
      // Jugend mit freigegebenen Spielerbildern: Gruppenbild und Porträts.
      setConfig({ site_enabled: 'true', team_ids: `${TEAM},${SENIOR}`, site_photos: `${SENIOR}=mannschaft+spieler,${TEAM}=mannschaft+spieler` });
      const jugend = (await get(`/${TEAM}/`)).body;
      expect(jugend).toContain('./foto/gruppe.jpg');
      expect(jugend).toContain('<img src="./foto/7001.jpg"');
      expect(jugend).toContain('<b>Jugendlicher</b>');
      expect((await get(`/${TEAM}/foto/gruppe.jpg`)).statusCode).toBe(200);
      expect((await get(`/${TEAM}/foto/7001.jpg`)).statusCode).toBe(200);
      // Nur das Gruppenbild freigegeben: Porträts bleiben weg.
      setConfig({ site_enabled: 'true', team_ids: `${TEAM},${SENIOR}`, site_photos: `${SENIOR}=mannschaft` });
      expect((await get(`/${SENIOR}/`)).body).not.toContain('./foto/8001.jpg');
      expect((await get(`/${SENIOR}/foto/8001.jpg`)).statusCode).toBe(404);
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
    setConfig({ site_enabled: 'true' });
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
    expect(manifest.json()).toMatchObject({ name: 'HSG Wölfe Voreifel mB-Jugend', short_name: 'mB-Jugend', start_url: './', display: 'standalone', theme_color: '#003e51' });
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

  it('zeigt zu jedem gespielten Spiel eine Spielseite — mit Dateien aus der Ebene darüber, ohne eigenen Service Worker', async () => {
    const plan = (await get(`/${TEAM}/`)).body;
    expect(plan).toContain('href="./spiel/m1"');
    expect(plan).not.toContain('href="./spiel/m3"');
    const res = await get(`/${TEAM}/spiel/m1`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    const html = res.body;
    expect(html).toContain('<b class="tore-gross">30:22</b>');
    expect(html).toContain('href="../site.css?v=');
    expect(html).toContain('src="../app.js?v=');
    expect(html).toContain('src="../bild/endstand.png?match=m1"');
    expect(html).toContain('<a class="zurueck" href="../">');
    expect(html).toContain('property="og:image" content="https://todo.test.local/96254/bild/endstand.png?match=m1"');
    expect(html).not.toContain('rel="manifest"');
    expect(html).not.toContain('Spielbericht</h2>');
    // Kommende Spiele haben ebenfalls eine Seite — mit Paarung statt Endstand.
    const kommend = await get(`/${TEAM}/spiel/m3`);
    expect(kommend.statusCode).toBe(200);
    expect(kommend.body).toContain('<b class="tore-gross">vs.</b>');
    expect(kommend.body).not.toContain('bild/endstand.png');
  });

  it('antwortet für unbekannte oder unzulässige Spiele und ohne Freigabe mit 404', async () => {
    expect((await get(`/${TEAM}/spiel/gibtsnicht`)).statusCode).toBe(404);
    expect((await get(`/${TEAM}/spiel/..%2F..%2Fx`)).statusCode).toBe(404);
    expect((await get(`/99999/spiel/m1`)).statusCode).toBe(404);
    setConfig({});
    expect((await get(`/${TEAM}/spiel/m1`)).statusCode).toBe(404);
    // Die frühere Übersicht gibt es nicht mehr.
    setConfig({ site_enabled: 'true' });
    expect((await get('/uebersicht/')).statusCode).toBe(404);
    expect((await get('/uebersicht')).statusCode).toBe(404);
  });

  it('bestimmt das Wochenende (Fr–So): Montag bis Freitag das kommende, Samstag und Sonntag das laufende', async () => {
    const { naechstesWochenende } = await import('../lib/handballSite');
    const erwartet = { fr: '2026-10-16', sa: '2026-10-17', so: '2026-10-18' };
    for (const tag of ['2026-10-12', '2026-10-14', '2026-10-16', '2026-10-17', '2026-10-18']) {
      expect(naechstesWochenende(new Date(`${tag}T10:00:00+02:00`)), tag).toEqual(erwartet);
    }
    expect(naechstesWochenende(new Date('2026-10-19T00:30:00+02:00'))).toEqual({ fr: '2026-10-23', sa: '2026-10-24', so: '2026-10-25' });
  });

  it('springt in den Ferien zum nächsten Spieltag und zeigt danach das letzte gespielte Wochenende', async () => {
    const { spielWochenende, letztesSpielWochenende } = await import('../lib/handballSite');
    const { handballOverview } = await import('../lib/handballSicht');
    const vorlage = handballOverview().teams[0].matches[0];
    const spiel = (start: string, status: string, a: number | null = null, b: number | null = null) =>
      ({ ...vorlage, starts_at: start, status, score_home: a, score_away: b, rated: false });
    const montag = new Date('2026-10-19T10:00:00+02:00');
    // Herbstferien: Das kommende Wochenende ist leer, ein Mittwochsspiel zählt nicht — das nächste Spiel ist am 7.11.
    const ferien = [spiel('2026-10-28T19:00:00+01:00', 'scheduled'), spiel('2026-11-07T15:00:00+01:00', 'scheduled'), spiel('2026-11-14T15:00:00+01:00', 'scheduled')];
    expect(spielWochenende(ferien, montag)).toEqual({ fr: '2026-11-06', sa: '2026-11-07', so: '2026-11-08' });
    // Spielt jemand am kommenden Wochenende, bleibt es dabei.
    expect(spielWochenende([...ferien, spiel('2026-10-25T11:00:00+01:00', 'scheduled')], montag)).toEqual({ fr: '2026-10-23', sa: '2026-10-24', so: '2026-10-25' });
    // Ergebnisse: das letzte Wochenende mit einem Ergebnis vor dem gezeigten, auch wenn es drei Wochen her ist.
    const gespielt = [spiel('2026-09-27T15:00:00+02:00', 'finished', 25, 20), spiel('2026-10-03T15:00:00+02:00', 'finished', 20, 21)];
    expect(letztesSpielWochenende(gespielt, { fr: '2026-10-23', sa: '2026-10-24', so: '2026-10-25' })).toEqual({ fr: '2026-10-02', sa: '2026-10-03', so: '2026-10-04' });
    expect(letztesSpielWochenende([], { fr: '2026-10-23', sa: '2026-10-24', so: '2026-10-25' })).toEqual({ fr: '2026-10-16', sa: '2026-10-17', so: '2026-10-18' });
  });

  it('zeigt auf der Startseite Heim- und Auswärtsspiele von Freitag bis Sonntag in sortierbaren Tabellen mit Halle', async () => {
    const { renderStartHtml } = await import('../lib/handballSitePages');
    const { handballOverview } = await import('../lib/handballSicht');
    const t = handballOverview().teams[0];
    const vorlage = t.matches[0];
    const spiel = (id: string, start: string, heim: boolean, halle: string | null, adresse: string | null) => ({
      ...vorlage, match_id: id, starts_at: start, status: 'scheduled', is_live: false, is_home: heim, score_home: null, score_away: null, won: null, rated: false,
      home_name: heim ? 'HSG Wölfe' : 'Gegner A', away_name: heim ? 'Gegner A' : 'HSG Wölfe', venue_name: halle, venue_address: adresse, venue_lat: null, venue_lon: null,
    });
    const team = { ...t, label: 'B-Jugend', group: 'jungen' as const, next_match: null, last_match: null, matches: [
      spiel('f', '2026-10-16T18:30:00+02:00', true, 'Halle Nord', null),
      spiel('a', '2026-10-17T10:00:00+02:00', true, 'Halle Süd', 'Hauptstr. 1, 53332 Bornheim'),
      spiel('c', '2026-10-18T11:00:00+02:00', true, 'Sporthalle Nord', null),
      spiel('d', '2026-10-18T14:00:00+02:00', false, 'Fremde Halle', null),
      spiel('e', '2026-10-24T14:00:00+02:00', true, 'Zu spät', null),
      spiel('v', '2026-10-15T19:00:00+02:00', true, 'Zu früh', null),
    ] };
    const html = renderStartHtml([team], { teams: [], baseUrl: 'https://x.test/', stand: null, now: new Date('2026-10-14T12:00:00+02:00') });
    expect(html).toContain('nächstes Wochenende');
    // Freitag, Samstag und Sonntag; davor und danach nichts. Das Auswärtsspiel steht in der zweiten Tabelle.
    expect(html.match(/<tr data-ts=/g)?.length).toBe(4);
    const heim = html.slice(html.indexOf('id="heimspiele"'), html.indexOf('id="auswaertsspiele"'));
    expect(heim.match(/<tr data-ts=/g)?.length).toBe(3);
    expect(heim).not.toContain('Fremde Halle');
    expect(html.slice(html.indexOf('id="auswaertsspiele"'))).toContain('Fremde Halle');
    expect(html).toContain('<h2>Tabellenplätze</h2>');
    // Nach Bereich gruppiert wie die Kästen im Kopf.
    expect(html).toContain('<tr class="bereich"><th scope="rowgroup" colspan="4">Jugend männlich</th></tr>');
    expect(html).not.toContain('Alle Mannschaften</h2>');
    expect(html).not.toContain('Zu spät');
    expect(html).not.toContain('Zu früh');
    // Spielort mit Adresse und Route; Sortier-Chips mit den drei Arten, Datum zuerst gewählt.
    expect(html).toContain('<b>📍 Halle Süd</b><small>Hauptstr. 1, 53332 Bornheim</small>');
    expect(html).toContain('https://www.google.com/maps/search/?api=1&amp;query=Hauptstr.');
    expect(html).toContain('data-sort="datum" aria-pressed="true"');
    expect(html).toContain('data-sort="ort" aria-pressed="false"');
    expect(html).toContain('data-sort="gruppe" aria-pressed="false">Herren · Damen · Jugend</button>');
    expect(html.indexOf('Halle Nord')).toBeLessThan(html.indexOf('Halle Süd'));
    expect(html).toContain('data-ort="halle süd" data-gr="2"');
  });

  it('bietet Teilen an: Knöpfe mit absoluter Adresse und Bild, Vorschaubild für jeden geteilten Link, gültiges Skript', async () => {
    const { SITE_APP_JS } = await import('../lib/handballSite');
    expect(() => new Function(SITE_APP_JS)).not.toThrow();
    const team = (await get(`/${TEAM}/`)).body;
    // Nächstes Spiel: die Mannschaftsseite (deren Vorschaubild ist das Spielbild), letztes: die Spielseite mit Endstandbild.
    expect(team).toContain('data-url="https://todo.test.local/96254/" data-titel=');
    expect(team).toContain('data-bild="./bild/spiel.png"');
    expect(team).toContain('data-url="https://todo.test.local/96254/spiel/m2"');
    expect(team).toContain('data-bild="./bild/endstand.png?match=m2"');
    expect(team).toMatch(/<button type="button" class="btn teilen" data-teilen[^>]* hidden>/);
    const spiel = (await get(`/${TEAM}/spiel/m1`)).body;
    expect(spiel).toContain('data-url="https://todo.test.local/96254/spiel/m1"');
    expect(spiel).toContain('property="og:image" content="https://todo.test.local/96254/bild/endstand.png?match=m1"');
    // Die Startseite hat ein Vorschaubild (das Logo) und teilt sich selbst.
    const start = (await get('/')).body;
    expect(start).toContain('property="og:image" content="https://todo.test.local/96254/logo.png"');
    expect(start).toContain('name="twitter:card" content="summary"');
    expect(start).toContain('data-teilen data-url="https://todo.test.local/"');
  });

  it('ordnet E- und F-Jugend und Minis den Kindern zu, A–D den Jugendgruppen', async () => {
    const { gruppeVon } = await import('../lib/handballSicht');
    const g = (wettbewerb: string, name = 'HSG') => gruppeVon(name, [{ competition_name: wettbewerb, championship_name: null }], null);
    expect(g('Kreisliga mE')).toBe('kinder');
    expect(g('Kreisliga wE-Jugend')).toBe('kinder');
    expect(g('Minis Staffel 1')).toBe('kinder');
    expect(g('Kreisliga mD')).toBe('jungen');
    expect(g('Kreisliga wC')).toBe('maedchen');
    expect(g('Landesliga Frauen')).toBe('frauen');
    expect(g('Landesliga Männer')).toBe('herren');
  });

  it('zeigt im Live-Modus den ganzen Torverlauf — die letzten Tore offen, die früheren zum Aufklappen', async () => {
    const id = `${TEAM}:m3`;
    const items = Array.from({ length: 9 }, (_, i) => ({ minute: 2 + i * 2, home: i < 5 ? i + 1 : 5, away: i < 5 ? 0 : i - 4, goal: true, block: '1. Halbzeit' }));
    db.update(schema.handball_team_match).set({
      starts_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      live_payload: JSON.stringify({ fetched_at: new Date().toISOString(), home: 5, away: 4, minute: '19:40', block: '1. Halbzeit', halftime: null, items }),
    }).where(eq(schema.handball_team_match.id, id)).run();
    try {
      const html = (await get(`/${TEAM}/`)).body;
      expect(html).toContain('data-stand="5:4"');
      expect(html).toContain('<details class="more ticker"><summary>Alle 9 Tore</summary>');
      expect(html).toContain('aria-label="Frühere Tore"');
      // Neueste zuerst; das Tor der Gäste ist der Gegenseite zugeschrieben.
      expect(html).toContain('Tor für HV Erftstadt · <b>5:4</b>');
      expect(html.indexOf('5:4</b>')).toBeLessThan(html.indexOf('1:0</b>'));
      expect(html.match(/<li(?: class="eigen")?><span class="min">/g)?.length).toBe(9);
      expect(html).toContain('data-heim="1"');
      expect(html).toContain('data-vibration');
    } finally {
      db.update(schema.handball_team_match).set({ starts_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), live_payload: null }).where(eq(schema.handball_team_match.id, id)).run();
    }
  });

  it('nennt im Live-Ticker den Werfer: eigene mit Namen aus dem Kader, Gegner mit Rückennummer', async () => {
    const id = `${TEAM}:m3`;
    const items = [
      { minute: 2, home: 1, away: 0, goal: true, block: '1. Halbzeit', player_id: 'p1', number: 7, is_home: true },
      { minute: 3, home: 2, away: 0, goal: true, block: '1. Halbzeit', player_id: 'p5', number: 5, is_home: true },
      { minute: 4, home: 2, away: 1, goal: true, block: '1. Halbzeit', player_id: 'x9', number: 11, is_home: false },
    ];
    db.insert(schema.handball_roster).values({ id: `${TEAM}:p1`, team_id: TEAM, player_id: 'p1', first_name: 'Erika', last_name: 'Muster', number: 7, role: 'player', season_id: 2627, updated_at: new Date().toISOString() }).run();
    db.update(schema.handball_team_match).set({
      starts_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      live_payload: JSON.stringify({ fetched_at: new Date().toISOString(), home: 2, away: 1, minute: '04:10', block: '1. Halbzeit', halftime: null, items }),
    }).where(eq(schema.handball_team_match.id, id)).run();
    try {
      const html = (await get(`/${TEAM}/`)).body;
      // Die eigene Mannschaft heißt auf der Seite unter ihrem Label, auch im Ticker.
      expect(html).toContain('<li class="eigen"><span class="min">2.</span> Tor für mB-Jugend <span class="werfer">(Erika Muster)</span> · <b>1:0</b>');
      expect(html).toContain('Tor für mB-Jugend <span class="werfer">(Nr. 5)</span> · <b>2:0</b>');
      expect(html).toContain('Tor für HV Erftstadt <span class="werfer">(Nr. 11)</span> · <b>2:1</b>');
    } finally {
      db.delete(schema.handball_roster).run();
      db.update(schema.handball_team_match).set({ starts_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), live_payload: null }).where(eq(schema.handball_team_match.id, id)).run();
    }
  });

  it('zeigt auswärts live den Stand Heim:Gast mit dem Gastgeber links', async () => {
    const id = `${TEAM}:m2`;
    const alt = db.select().from(schema.handball_team_match).where(eq(schema.handball_team_match.id, id)).get()!;
    db.update(schema.handball_team_match).set({
      starts_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), status: 'scheduled', score_home: null, score_away: null,
      live_payload: JSON.stringify({ fetched_at: new Date().toISOString(), home: 3, away: 1, minute: '06:00', block: '1. Halbzeit', halftime: null, items: [] }),
    }).where(eq(schema.handball_team_match.id, id)).run();
    db.update(schema.handball_team_match).set({ starts_at: new Date(Date.now() + 9 * 24 * 3600 * 1000).toISOString() }).where(eq(schema.handball_team_match.id, `${TEAM}:m3`)).run();
    try {
      const html = (await get(`/${TEAM}/`)).body;
      expect(html).toMatch(/data-stand="3:1" data-heim="0">\s*<span class="seite">HV Erftstadt<\/span>\s*<b class="tore-gross">3:1<\/b>\s*<span class="seite">mB-Jugend<\/span>/);
    } finally {
      db.update(schema.handball_team_match).set({ starts_at: alt.starts_at, status: alt.status, score_home: alt.score_home, score_away: alt.score_away, live_payload: null }).where(eq(schema.handball_team_match.id, id)).run();
      db.update(schema.handball_team_match).set({ starts_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString() }).where(eq(schema.handball_team_match.id, `${TEAM}:m3`)).run();
    }
  });

  it('bringt im Skript Tor-Hinweis, sekundengenauen Countdown und den Service Worker nur mit Manifest', async () => {
    const js = (await get(`/${TEAM}/app.js`)).body;
    expect(js).toContain("className = 'toast'");
    expect(js).toContain('navigator.vibrate');
    expect(js).toContain("'Tor! '");
    expect(js).toContain('setInterval(countdown, 1000)');
    expect(js).toContain('Gleich los');
    expect(js).toContain("document.querySelector('link[rel=manifest]')");
    expect(js).toContain('details.ticker[open]');
    // Das Muster für den Stand muss als Regex im ausgelieferten Skript stehen, nicht als „d+".
    expect(js).toContain('/^(\\d+):(\\d+)$/');
  });

  it('liefert Feed und Kalender', async () => {
    const feed = await get(`/${TEAM}/feed.xml`);
    expect(feed.statusCode).toBe(200);
    expect(feed.headers['content-type']).toContain('rss+xml');
    expect(feed.body).toContain('<rss version="2.0"');
    expect(feed.body).toContain('HSG Wölfe Voreifel – HV Erftstadt 30:22 · Sieg');
    expect(feed.body).toContain('HV Erftstadt – HSG Wölfe Voreifel 25:20 · Niederlage');
    expect(feed.body).toContain('Nächstes Spiel: HSG Wölfe Voreifel gegen HV Erftstadt');
    const ics = await get(`/${TEAM}/kalender.ics`);
    expect(ics.statusCode).toBe(200);
    expect(ics.headers['content-type']).toContain('text/calendar');
    expect(ics.body).toContain('BEGIN:VCALENDAR');
    expect(ics.body).toContain('UID:handball-m3@todoteck');
  });

  describe('Seitenfunktionen: Mini-Kopf, Kalender, Steckbrief, Tagesansicht', () => {
    it('trägt auf der Mannschaftsseite einen Mini-Kopf, der nur mit Skript erscheint', async () => {
      const html = (await get(`/${TEAM}/`)).body;
      expect(html).toContain('<div class="mini" data-mini hidden inert>');
      expect(html).toContain('1. Platz');
      const js = (await get(`/${TEAM}/app.js`)).body;
      expect(js).toContain('IntersectionObserver');
      expect(js).toContain("document.querySelector('[data-mini]')");
      expect((await get(`/${TEAM}/site.css`)).body).toContain('html.kompakt .mini{display:none}');
    });

    it('zeigt den Spielplan zusätzlich als Monatskalender mit Heim/Auswärts-Buchstaben', async () => {
      const html = (await get(`/${TEAM}/`)).body;
      expect(html).toContain('data-ansicht="kalender"');
      expect(html).toContain('<div class="kal" data-kalender>');
      // m1: Heimsieg 30:22 vor einer Woche, m2: Auswärtsniederlage 20:25 — klassisch Heim:Gast, also 25:20.
      expect(html).toMatch(/<a class="chip heim w" href="\.\/spiel\/m1"[^>]*>H 30:22<\/a>/);
      expect(html).toMatch(/<a class="chip aus l" href="\.\/spiel\/m2"[^>]*>A 25:20<\/a>/);
      expect(html).toMatch(/<span class="chip heim"[^>]*>H \d\d:\d\d<\/span>/);
      expect(html).toContain('data-monat-weiter');
      const js = (await get(`/${TEAM}/app.js`)).body;
      expect(js).toContain('handball-site-ansicht');
    });

    it('öffnet zu jeder fremden Tabellenzeile den Steckbrief als Fenster', async () => {
      const html = (await get(`/${TEAM}/`)).body;
      expect(html).toContain('data-sb="sb-96300"');
      expect(html).toContain('<dialog class="popup steckbrief" id="sb-96300"');
      // Die eigene Zeile bleibt eine Zeile.
      expect(html).not.toContain('data-sb="sb-96254"');
      // Der Direktvergleich im Steckbrief nennt das Hinspiel (m2, auswärts 20:25 verloren, ohne m3).
      const sb = html.slice(html.indexOf('id="sb-96300"'));
      expect(sb).toContain('2. Platz');
      expect((await get(`/${TEAM}/app.js`)).body).toContain("tr[data-sb]");
    });

    it('zeigt auf der Startseite Heute und die Ergebnisse des letzten Wochenendes', async () => {
      const heuteSpiel = (id: string, start: string, status: string, a: number | null, b: number | null) => ({
        id: `${TEAM}:${id}`, team_id: TEAM, match_id: id, season_id: 2627, starts_at: start,
        status, status_name: status, round: 5, phase_id: 12800, competition_name: 'Kreisoberliga mB', championship_name: 'B-Jugend',
        home_id: TEAM, home_name: 'HSG Wölfe Voreifel', away_id: '96300', away_name: 'HV Erftstadt',
        score_home: a, score_away: b, venue_name: 'Sporthalle Heimerzheim', venue_address: 'Schulstraße 1', notified_upcoming: false, notified_result: false, updated_at: new Date().toISOString(),
      });
      // Heute 12:00 und 14:00 Ortszeit (kommend) – damit der Test zu jeder Tageszeit denselben Tag trifft.
      const heute = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
      const mittag = new Date(`${heute}T11:00:00Z`).toISOString();
      const nachmittag = new Date(`${heute}T13:00:00Z`).toISOString();
      db.insert(schema.handball_team_match).values([heuteSpiel('t1', mittag, 'scheduled', null, null), heuteSpiel('t2', nachmittag, 'scheduled', null, null)] as never).run();
      try {
        const start = (await get('/')).body;
        expect(start).toContain('<section class="card dark" id="heute">');
        expect(start).toContain('<span class="e">Heim</span>');
        expect(start).toContain('Sporthalle Heimerzheim');
        // Letztes Wochenende: nur, wenn ein Ergebnis in Fr–So der Vorwoche liegt — hier per Direkteintrag. Ein
        // Unentschieden, weil m1 (ein Sieg vor sieben Tagen) je nach Wochentag ins selbe Wochenende fällt.
        const jetzt = new Date();
        const wt = jetzt.getUTCDay();
        const samstagVorWoche = new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), jetzt.getUTCDate() + (wt === 0 ? -1 : 6 - wt) - 7, 12)).toISOString();
        db.insert(schema.handball_team_match).values(heuteSpiel('lw1', samstagVorWoche, 'finished', 27, 27) as never).run();
        const mitLetztem = (await get('/')).body;
        expect(mitLetztem).toContain('id="letztes-wochenende"');
        expect(mitLetztem).toContain('1 Unentschieden');
        expect(mitLetztem).toContain('href="./96254/spiel/lw1"');
        expect(mitLetztem).toContain('27:27');
      } finally {
        db.delete(schema.handball_team_match).where(sql`${schema.handball_team_match.match_id} IN ('t1','t2','lw1')`).run();
      }
    });

    it('baut den Kopf der Startseite wie den der Mannschaftsseite: Logo und Verein oben, Kästen, darunter der Titel', async () => {
      const html = (await get('/')).body;
      expect(html.indexOf('class="verein"')).toBeLessThan(html.indexOf('class="kaesten flach'));
      expect(html.indexOf('class="kaesten flach')).toBeLessThan(html.indexOf('<h1>Wölfe live - Handball im Revier</h1>'));
    });

    it('sagt im Dialog, dass Verein und Mannschaft gleichzeitig gehen, und zeigt die Live-Ansicht schon vorher an', async () => {
      const team = (await get(`/${TEAM}/`)).body;
      expect(team).toContain('data-team="96254"');
      expect(team).toContain('Heim- und Auswärtsspiele dieser Mannschaft');
      expect(team).toContain('beides geht gleichzeitig');
      expect(team).toContain('data-andere hidden');
      expect(team).not.toContain('nur eine Anmeldung je Gerät');
      expect(team).toContain('<b>Live ab Anwurf:</b>');
      expect(team).not.toContain('<body data-live');
      const start = (await get('/')).body;
      expect(start).toContain('data-scope="club"');
      expect(start).toContain('alle Heimspiele aller Mannschaften');
      expect(start).toContain('<section class="card live-leer" id="live">');
      expect(start).toContain('<b>Nächster Anwurf:</b>');
      expect(start).not.toContain('<body data-live');
      const js = (await get(`/${TEAM}/app.js`)).body;
      expect(js).toContain("var PREFIX = 'handball-site-push:'");
    });

    it('schaltet die Seiten 20 Minuten vor dem Anwurf selbst auf Live und hält sie kurz im Zwischenspeicher', async () => {
      const id = `${TEAM}:m3`;
      db.update(schema.handball_team_match).set({ starts_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }).where(eq(schema.handball_team_match.id, id)).run();
      try {
        const team = await get(`/${TEAM}/`);
        expect(team.body).toContain('<body data-live="1">');
        expect(team.headers['cache-control']).toContain('max-age=15');
        const start = await get('/');
        expect(start.body).toContain('<body data-live="1">');
        expect(start.headers['cache-control']).toContain('max-age=15');
      } finally {
        db.update(schema.handball_team_match).set({ starts_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString() }).where(eq(schema.handball_team_match.id, id)).run();
      }
    });

    it('setzt eine Sprungleiste mit Ankern zu den vorhandenen Abschnitten', async () => {
      const team = (await get(`/${TEAM}/`)).body;
      expect(team).toContain('<nav class="sprung" aria-label="Abschnitte" data-sprung>');
      for (const [id, label] of [['naechstes', 'Nächstes Spiel'], ['letztes', 'Letztes Spiel'], ['tabelle', 'Tabelle'], ['spielplan', 'Spielplan']]) {
        expect(team).toContain(`<li><a href="#${id}">${label}</a></li>`);
        expect(team).toContain(`id="${id}"`);
      }
      // Ohne Spielernamen keine Statistiken, also auch kein Chip dafür.
      expect(team).not.toContain('href="#statistiken"');
      // Die Saison steht zugeklappt unter der Tabelle, ohne eigenen Abschnitt und Chip.
      expect(team).not.toContain('href="#saison"');
      const tabelle = team.slice(team.indexOf('id="tabelle"'));
      expect(tabelle.slice(0, tabelle.indexOf('</section>'))).toContain('<details class="more season" id="saison"><summary>Saisonverlauf</summary>');
      expect(team.indexOf('data-sprung')).toBeLessThan(team.indexOf('id="inhalt"'));
      const start = (await get('/')).body;
      expect(start).toContain('<li><a href="#live">Live</a></li>');
      expect(start).toContain('<li><a href="#stand">Tabellenplätze</a></li>');
      // Jeder Chip heißt wie die Überschrift seines Abschnitts — auf beiden Seiten.
      for (const seite of [team, start]) {
        const chips = [...seite.matchAll(/<li><a href="#([^"]+)">([^<]+)<\/a><\/li>/g)];
        expect(chips.length).toBeGreaterThan(1);
        for (const [, id, label] of chips) {
          const abschnitt = seite.slice(seite.indexOf(`id="${id}"`));
          const titel = abschnitt.slice(abschnitt.indexOf('<h2>') + 4).split(/ <|<\/h2>/)[0];
          expect(titel, id).toBe(label);
        }
      }
      const js = (await get(`/${TEAM}/app.js`)).body;
      expect(js).toContain("document.querySelector('[data-sprung]')");
      expect((await get(`/${TEAM}/site.css`)).body).toContain('.sprung{position:sticky;top:var(--oben,0px)');
    });

    it('klappt Nebenabschnitte mit Skript zunächst ein, mit einer Zeile Vorschau', async () => {
      const start = (await get('/')).body;
      expect(start).toContain('<section class="card" id="auswaertsspiele" data-klappe="auswaerts">');
      // Ob am Wochenende ein Auswärtsspiel liegt, hängt am Wochentag des Testlaufs (m2 ist von heute) — geprüft wird die Vorschauzeile.
      expect(start).toMatch(/<p class="vorschau" hidden>(Kein Auswärtsspiel|\d+ Auswärtsspiele?) von Freitag bis Sonntag<\/p>/);
      expect(start).toContain('id="stand" data-klappe="stand"');
      // Heimspiele und Live bleiben immer offen.
      expect(start).not.toMatch(/id="heimspiele"[^>]*data-klappe/);
      expect(start).not.toMatch(/id="live"[^>]*data-klappe/);
      const team = (await get(`/${TEAM}/`)).body;
      // Mit drei Spielen gibt es nichts zu kürzen; das nächste Spiel und die Tabelle bleiben offen.
      expect(team).not.toContain('id="spielplan" data-klappe');
      expect(team).toMatch(/<li class="next" data-kurz/);
      expect(team).not.toMatch(/id="naechstes"[^>]*data-klappe/);
      expect(team).not.toMatch(/id="tabelle"[^>]*data-klappe/);
      const js = (await get(`/${TEAM}/app.js`)).body;
      expect(js).toContain("'handball-site-klappe:'");
      expect(js).toContain('function ankerOeffnen(hash)');
      expect((await get(`/${TEAM}/site.css`)).body).toContain('#spielplan.zu .plan li:not([data-kurz]){display:none}');
    });

    it('rendert das Wochenende als Bild, nur bei freigegebener Seite', async () => {
      const res = await get('/bild/wochenende.png');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.rawPayload.subarray(1, 4).toString()).toBe('PNG');
      expect((await get('/')).body).toContain('data-bild="./bild/wochenende.png"');
    });

    it('bringt Tab-Titel, Start-Ticker und Platzhalter für Bilder im Skript', async () => {
      const js = (await get(`/${TEAM}/app.js`)).body;
      expect(js).toContain('titelSetzen');
      expect(js).toContain('Spiele live');
      expect(js).toContain("#naechstes [data-stand], #live [data-stand]");
      expect(js).toContain("classList.add('fertig')");
      const css = (await get(`/${TEAM}/site.css`)).body;
      expect(css).toContain('@keyframes skel');
      expect(css).toContain('.card img.bild:not(.fertig)');
    });
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
      expect(res.json()).toEqual({ ok: true, lead: '3h', mode: 'all', topics: ['upcoming', 'halftime', 'result', 'change'] });
      await new Promise(r => setTimeout(r, 10));
      expect(sendPush).toHaveBeenCalledTimes(1);
      expect(sendPush.mock.calls[0][0]).toMatchObject({ endpoint: sub.endpoint });
      expect(sendPush.mock.calls[0][1].title).toContain('Benachrichtigungen an');

      const zwei = await post({ subscription: sub, lead: 'aus', mode: 'results' });
      expect(zwei.json()).toEqual({ ok: true, lead: 'aus', mode: 'results', topics: ['result', 'change'] });
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
      expect(res.json()).toMatchObject({ ok: true, lead: '1h', mode: 'all' });
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

      // Der Push nennt die Mannschaft mit dem eingestellten Vereinsnamen, nicht mit dem von handball.net.
      process.env.CLUB_NAME = 'Wölfe Voreifel';
      const r = await sitePush.pushHandballSite(new Date(), deps).finally(() => { delete process.env.CLUB_NAME; });
      // Ein Endstand (m2, 90 Minuten alt) an beide; m1 ist eine Woche alt und wird nur gemerkt.
      expect(r.messages).toBe(1);
      expect(r.recipients).toBe(1);
      const payloads = sendPush.mock.calls.map(c => c[1] as { title: string; image?: string; tag?: string; vibrate?: number[] });
      expect(payloads).toHaveLength(2);
      expect(payloads[0].title).toMatch(/^🏁 HV Erftstadt – Wölfe Voreifel 25:20 · Niederlage/);
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

    it('stellt an viele Abonnenten parallel zu, höchstens PUSH_PARALLEL gleichzeitig (PRF-2-003)', async () => {
      sitePush.resetSiteSent();
      const viele = Array.from({ length: 40 }, (_, i) => `https://fcm.googleapis.com/fcm/send/viele-${i}`);
      for (const endpoint of viele) sitePush.saveSiteSubscription(TEAM, { endpoint, p256dh: 'p'.repeat(32), auth: 'a'.repeat(16), lead: '1h', mode: 'all' });
      let gleichzeitig = 0; let hoechstens = 0;
      sendPush.mockImplementation(async () => {
        gleichzeitig++; hoechstens = Math.max(hoechstens, gleichzeitig);
        await new Promise(r => setTimeout(r, 30));
        gleichzeitig--;
        return { status: 'sent' };
      });
      try {
        const t0 = Date.now();
        const r = await sitePush.pushHandballSite(new Date(), deps);
        const dauer = Date.now() - t0;
        expect(r.recipients).toBeGreaterThanOrEqual(40);
        expect(hoechstens).toBe(sitePush.PUSH_PARALLEL);
        // Seriell wären es 40 × 30 ms = 1,2 s.
        expect(dauer).toBeLessThan(600);
      } finally {
        for (const endpoint of viele) sitePush.deleteSiteSubscription(endpoint);
      }
    });

    it('nimmt die gewählten Themen, wirft Unbekanntes und für eine Mannschaft die Wochenvorschau heraus', async () => {
      const res = await post({ subscription: sub, lead: '3h', topics: ['result', 'bogus', 'preview', 'result'] });
      expect(res.json()).toMatchObject({ ok: true, lead: '3h', topics: ['result'] });
      expect(sitePush.listSiteSubscribers(TEAM)[0]).toMatchObject({ topics: ['result'] });
      // Die Bestätigung nennt, was ankommt.
      await new Promise(r => setTimeout(r, 10));
      expect(sendPush.mock.calls.at(-1)![1].body).toContain('Endstand');
      expect(sendPush.mock.calls.at(-1)![1].body).not.toContain('Halbzeit');
      expect(sitePush.themenText({ topics: ['upcoming', 'halftime', 'change'], lead: 'abend' })).toBe('Ankündigung am Vorabend, Halbzeitstand und Verlegungen und Absagen');
      expect(sitePush.themenText({ topics: ['upcoming'], lead: 'aus' })).toBe('nichts');
    });

    it('schickt einem Abonnenten nur die Themen, die er gewählt hat', async () => {
      sitePush.resetSiteSent();
      sitePush.saveSiteSubscription(TEAM, { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, lead: '1h', mode: 'all', topics: ['change'] });
      sendPush.mockClear();
      sendPush.mockImplementation(async () => ({ status: 'sent' }));
      const r = await sitePush.pushHandballSite(new Date(), deps);
      expect(r.recipients).toBe(0);
      expect(sendPush).not.toHaveBeenCalled();
    });

    it('meldet den Verein an der Wurzel an: nur Heimspiele, Ziel und Bild vom Worker der Wurzel aus', async () => {
      const verein = { endpoint: 'https://fcm.googleapis.com/fcm/send/verein', keys: { p256dh: 'p'.repeat(32), auth: 'a'.repeat(16) } };
      expect((await get('/push')).json()).toEqual({ enabled: true, public_key: 'BTestVapidKey' });
      const res = await fastify.inject({ method: 'POST', url: '/push', payload: { subscription: verein, lead: '1h', topics: ['upcoming', 'result', 'preview', 'halftime'] } });
      expect(res.statusCode).toBe(200);
      expect(res.json().topics).toEqual(['upcoming', 'result', 'preview', 'halftime']);
      expect(sitePush.listClubSubscribers()).toHaveLength(1);
      await new Promise(r => setTimeout(r, 10));
      expect(sendPush.mock.calls.at(-1)![1].title).toContain('Wölfe live - Handball im Revier');
      expect(sendPush.mock.calls.at(-1)![1].body).toContain('zu allen Heimspielen');

      sitePush.resetSiteSent();
      sendPush.mockClear();
      sendPush.mockImplementation(async () => ({ status: 'sent' }));
      // m2 (Endstand) war ein Auswärtsspiel — für den Verein kein Push. m3 (Heimspiel) wird in 30 Minuten angekündigt.
      const kurzVorAnwurf = new Date(Date.now() + 7 * 24 * 3600 * 1000 - 30 * 60 * 1000);
      await sitePush.pushHandballSite(kurzVorAnwurf, deps);
      const payloads = sendPush.mock.calls.filter(c => c[0].endpoint === verein.endpoint).map(c => c[1] as { title: string; url?: string; image?: string });
      expect(payloads).toHaveLength(1);
      expect(payloads[0].title).not.toContain('Niederlage');
      expect(payloads[0].url).toBe('96254/');
      expect(payloads[0].image).toBe('96254/bild/spiel.png');

      expect((await fastify.inject({ method: 'DELETE', url: '/push', payload: { endpoint: verein.endpoint } })).json()).toEqual({ ok: true, removed: 1 });
    });

    it('schickt am Donnerstagabend „Dieses Wochenende: N Heimspiele“ — ohne Halle, einmal, nur an den Verein', async () => {
      // Donnerstag, 15.10.2026, 18 Uhr Ortszeit: Wochenende 16.–18.10.
      const donnerstag = new Date('2026-10-15T16:00:00Z');
      const heim = (id: string, start: string, heimspiel = true) => ({
        id: `${TEAM}:${id}`, team_id: TEAM, match_id: id, season_id: 2627, starts_at: start,
        status: 'scheduled', status_name: 'scheduled', round: 4, phase_id: 12800, competition_name: 'Kreisoberliga mB', championship_name: 'B-Jugend',
        home_id: heimspiel ? TEAM : '96300', home_name: heimspiel ? 'HSG Wölfe Voreifel' : 'HV Erftstadt', away_id: heimspiel ? '96300' : TEAM, away_name: heimspiel ? 'HV Erftstadt' : 'HSG Wölfe Voreifel',
        score_home: null, score_away: null, venue_name: 'Sporthalle Heimerzheim', venue_address: 'Schulstraße 1', notified_upcoming: false, notified_result: false, updated_at: new Date().toISOString(),
      });
      db.insert(schema.handball_team_match).values([
        heim('w1', '2026-10-17T09:00:00Z'), heim('w2', '2026-10-17T11:00:00Z'), heim('w3', '2026-10-18T10:00:00Z'), heim('w4', '2026-10-17T13:00:00Z', false),
      ] as never).run();
      // Die Grund-Spiele m1–m3 liegen relativ zu heute und könnten aufs Testwochenende fallen — für den Test weg damit.
      const grund = db.select().from(schema.handball_team_match).where(sql`${schema.handball_team_match.match_id} IN ('m1','m2','m3')`).all();
      db.update(schema.handball_team_match).set({ starts_at: '2020-01-01T12:00:00Z' }).where(sql`${schema.handball_team_match.match_id} IN ('m1','m2','m3')`).run();
      const verein = { endpoint: 'https://fcm.googleapis.com/fcm/send/vorschau', keys: { p256dh: 'p'.repeat(32), auth: 'a'.repeat(16) } };
      sitePush.saveSiteSubscription(sitePush.CLUB, { endpoint: verein.endpoint, p256dh: verein.keys.p256dh, auth: verein.keys.auth, lead: 'aus', mode: 'all', topics: ['preview'] });
      try {
        sitePush.resetSiteSent();
        sendPush.mockClear();
        sendPush.mockImplementation(async () => ({ status: 'sent' }));
        // Mittwoch: noch zu früh. Donnerstag 16 Uhr: auch.
        await sitePush.pushHandballSite(new Date('2026-10-14T16:00:00Z'), deps);
        await sitePush.pushHandballSite(new Date('2026-10-15T14:00:00Z'), deps);
        expect(sendPush).not.toHaveBeenCalled();

        const r = await sitePush.pushHandballSite(donnerstag, deps);
        expect(r.messages).toBe(1);
        const p = sendPush.mock.calls[0]![1] as { title: string; body: string };
        expect(p.title).toBe('Dieses Wochenende: 3 Heimspiele');
        expect(p.body).toBe('Samstag 2 · Sonntag 1');
        expect(p.body + p.title).not.toContain('Sporthalle');

        sendPush.mockClear();
        await sitePush.pushHandballSite(new Date('2026-10-15T17:00:00Z'), deps);
        expect(sendPush).not.toHaveBeenCalled();
      } finally {
        sitePush.deleteSiteSubscription(verein.endpoint);
        db.delete(schema.handball_team_match).where(sql`${schema.handball_team_match.match_id} IN ('w1','w2','w3','w4')`).run();
        for (const g of grund) db.update(schema.handball_team_match).set({ starts_at: g.starts_at }).where(eq(schema.handball_team_match.id, g.id)).run();
      }
    });

    it('zeigt im Dialog die Themen mit Beispieltext — auf der Startseite die Vereinsanmeldung', async () => {
      const team = (await get(`/${TEAM}/`)).body;
      expect(team).toContain('name="thema" value="halftime"');
      expect(team).toContain('„Halbzeit: 14:12“');
      expect(team).not.toContain('value="preview"');
      expect(team).not.toContain('name="mode"');
      const start = (await get('/')).body;
      expect(start).toContain('data-scope="club"');
      expect(start).toContain('value="preview"');
      expect(start).toContain('Dieses Wochenende: 4 Heimspiele');
      // Kalender und Feed gibt es nur je Mannschaft.
      expect(start).not.toContain('kalender.ics');
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
