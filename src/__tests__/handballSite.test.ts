import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { unlinkSync } from 'fs';
import type { PushPayload, PushResult, PushTarget } from '../lib/webPush';

/**
 * Die Handball-Microsite (docs/handball-verfolgung.md §7): die öffentliche
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
    expect(html).toContain('<script src="./app.js" defer></script>');
    expect(html).toContain('./bild/spiel.png');
    expect(html).toContain('./bild/endstand.png?match=m2');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('webcal://todo.test.local/96254/kalender.ics');
    expect(html).toContain('--p:#003e51');
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
    // Die Wege: Kalender-Abo und Feed als Kacheln, ICS und Teilen als Kleingedrucktes — kein Telegram, solange kein Bot registriert ist.
    expect(html).toContain('<b>Kalender-Abo</b>');
    expect(html).toContain('<b>RSS-Feed</b>');
    expect(html).toContain('data-share hidden');
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
      expect(html).toContain('<details class="more" open>');
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

  it('zeigt bei mehreren Mannschaften ein Dropdown mit relativen Zielen, die Wurzel führt zur ersten', async () => {
    expect((await get(`/${TEAM}/`)).body).not.toContain('data-teams');
    setConfig({ site_enabled: 'true', team_ids: '96254=B-Jugend,96300=C-Jugend' });
    db.insert(schema.handball_team_match).values({
      id: '96300:c1', team_id: '96300', match_id: 'c1', season_id: 2627, starts_at: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
      status: 'scheduled', status_name: 'scheduled', round: 1, phase_id: 12900, competition_name: 'Kreisliga mC', championship_name: 'C-Jugend',
      home_id: '96300', home_name: 'HSG Wölfe Voreifel', away_id: '96400', away_name: 'TV Palmersheim',
      score_home: null, score_away: null, venue_name: null, venue_address: null, notified_upcoming: false, notified_result: false, updated_at: new Date().toISOString(),
    } as never).run();
    try {
      const html = (await get(`/${TEAM}/`)).body;
      expect(html).toContain('<select data-teams');
      expect(html).toContain('<option value="../96254/" selected>B-Jugend</option>');
      expect(html).toContain('<option value="../96300/">C-Jugend</option>');
      expect((await get('/96300/')).statusCode).toBe(200);
      const wurzel = await get('/');
      expect(wurzel.statusCode).toBe(302);
      expect(wurzel.headers.location).toBe('96254/');
    } finally {
      db.delete(schema.handball_team_match).where(eq(schema.handball_team_match.team_id, '96300')).run();
    }
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
    expect(app.body).toContain('navigator.share');
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
    const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p'.repeat(32), auth: 'a'.repeat(16) } };
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
      // Unbekannter Vorlauf fällt auf den Standard zurück statt abzulehnen.
      const res = await post({ subscription: { ...sub, endpoint: 'https://push.example/def' }, lead: 'sofort', mode: 'egal' });
      expect(res.json()).toEqual({ ok: true, lead: '1h', mode: 'all' });
    });

    it('trägt wieder aus', async () => {
      const res = await fastify.inject({ method: 'DELETE', url: `/${TEAM}/push`, payload: { endpoint: 'https://push.example/def' } });
      expect(res.json()).toEqual({ ok: true, removed: 1 });
      expect(sitePush.listSiteSubscribers(TEAM).map(s => s.endpoint)).toEqual([sub.endpoint]);
    });

    it('schickt den frischen Endstand genau einmal — und löscht tote Abonnenten', async () => {
      sitePush.resetSiteSent();
      // Der Abonnent von oben will nur Ergebnisse; ein zweiter alles.
      sitePush.saveSiteSubscription(TEAM, { endpoint: 'https://push.example/tot', p256dh: 'p'.repeat(32), auth: 'a'.repeat(16), lead: '1h', mode: 'all' });
      sendPush.mockImplementation(async (target: { endpoint: string }) => (target.endpoint.endsWith('/tot') ? { status: 'gone', reason: 'HTTP 410' } : { status: 'sent' }));

      const r = await sitePush.pushHandballSite(new Date(), deps);
      // Ein Endstand (m2, 90 Minuten alt) an beide; m1 ist eine Woche alt und wird nur gemerkt.
      expect(r.messages).toBe(1);
      expect(r.recipients).toBe(1);
      const payloads = sendPush.mock.calls.map(c => c[1] as { title: string; image?: string; tag?: string });
      expect(payloads).toHaveLength(2);
      expect(payloads[0].title).toContain('HSG Wölfe Voreifel verliert 20:25');
      expect(payloads[0].image).toBe('bild/endstand.png?match=m2');
      expect(payloads[0].tag).toBe('handball-m2');
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
