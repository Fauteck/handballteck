/**
 * Die Einstellungsseite: Register, Vorrang der Seite vor der Umgebung,
 * Anmeldung, CSRF-Schutz und dass Geheimnisse nie zurückgehen.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync, unlinkSync } from 'fs';

const DB_FILE = `/tmp/handball-settings-${process.pid}.db`;
process.env.DATABASE_PATH = DB_FILE;
process.env.PUBLIC_URL = 'https://handball.test.local';
process.env.TEAM_IDS = '96254';
process.env.ADMIN_USER = 'chef';
process.env.ADMIN_PASSWORD = 'ein-langes-passwort-123';
delete process.env.ADMIN_PORT;
delete process.env.TELEGRAM_BOT_TOKEN;

const PW = 'ein-langes-passwort-123';

describe('Register', () => {
  it('prüft die Werte wie die Konfiguration sie liest', async () => {
    const { findeEinstellung } = await import('../lib/settingsRegistry');
    const p = (k: string, v: string) => findeEinstellung(k)!.pruefe(v);
    expect(p('TEAM_IDS', '96254=B-Jugend; 96300  abc')).toEqual({ ok: true, wert: '96254=B-Jugend,96300' });
    expect(p('TEAM_IDS', 'keine ziffern').ok).toBe(false);
    expect(p('TEAM_IDS', '').ok).toBe(true);
    expect(p('PRIMARY_COLOR', '#ABCDEF')).toEqual({ ok: true, wert: '#abcdef' });
    expect(p('PRIMARY_COLOR', 'rot').ok).toBe(false);
    expect(p('SYNC_INTERVAL_MS', '60000').ok).toBe(false);
    expect(p('SYNC_INTERVAL_MS', '300000').ok).toBe(true);
    expect(p('SYNC_LIVE_INTERVAL_MS', '0').ok).toBe(true);
    expect(p('SYNC_LIVE_INTERVAL_MS', '5000').ok).toBe(false);
    expect(p('SITE_URL', 'http://x.de').ok).toBe(false);
    expect(p('SITE_URL', 'https://woelfe.example.de/').ok).toBe(true);
    expect(p('CLUBDESK_URL', 'https://a.clubdesk.com/pfad').ok).toBe(false);
    expect(p('SITE_PREVIEW_TOKEN', 'kurz').ok).toBe(false);
    expect(p('SITE_PREVIEW_TOKEN', 'a'.repeat(32)).ok).toBe(true);
    expect(p('TELEGRAM_INVITE_CODE', 'mit leerzeichen').ok).toBe(false);
    expect(p('TELEGRAM_ADMIN_CHAT_IDS', '12, -100123, 12')).toEqual({ ok: true, wert: '12,-100123' });
    expect(p('SITE_FEEDBACK_MAIL', 'kein-at').ok).toBe(false);
    expect(p('SITE_OPERATOR', 'Zeile\nzwei').ok).toBe(false);
    expect(p('SITE_PLAYERS', 'ja')).toEqual({ ok: true, wert: 'true' });
    expect(p('CLUBDESK_TEAMS', '75796=woelfe_1')).toEqual({ ok: true, wert: '75796=woelfe_1' });
    expect(p('CLUBDESK_TEAMS', 'x=y').ok).toBe(false);
    expect(p('SITE_PHOTOS', '75796=spieler+mannschaft; 96254=Mannschaft')).toEqual({ ok: true, wert: '75796=mannschaft+spieler,96254=mannschaft' });
    expect(p('SITE_PHOTOS', '75796=alles').ok).toBe(false);
    expect(p('SITE_PHOTOS', '')).toEqual({ ok: true, wert: '' });
    expect(p('TEAM_GROUPS', '96254=Jungen; 75796=herren')).toEqual({ ok: true, wert: '96254=jungen,75796=herren' });
    expect(p('TEAM_GROUPS', '96254=senioren').ok).toBe(false);
    expect(p('TEAM_GROUPS', '')).toEqual({ ok: true, wert: '' });
  });

  it('steht vollständig in .env.example und README', async () => {
    const { EINSTELLUNGEN, STATUS_GEHEIMNISSE } = await import('../lib/settingsRegistry');
    const env = readFileSync('.env.example', 'utf8');
    const readme = readFileSync('README.md', 'utf8');
    const keys = [...EINSTELLUNGEN.map(e => e.key), ...STATUS_GEHEIMNISSE.map(g => g.key), 'ADMIN_USER', 'ADMIN_PASSWORD', 'ADMIN_PORT'];
    for (const k of keys) {
      expect(env, `.env.example: ${k}`).toContain(k);
      expect(readme, `README: ${k}`).toContain(k);
    }
  });
});

describe('Einstellungsseite', () => {
  let fastify: FastifyInstance;
  let konfig: typeof import('../config');
  let store: typeof import('../lib/settingsStore');
  let sessions: typeof import('../routes/settings');

  beforeAll(async () => {
    const { runMigrations } = await import('../db/migrate');
    runMigrations();
    konfig = await import('../config');
    store = await import('../lib/settingsStore');
    sessions = await import('../routes/settings');
    const { buildServer } = await import('../server');
    fastify = await buildServer({ logger: false });
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) { try { unlinkSync(f); } catch { /* nicht da */ } }
  });

  beforeEach(() => {
    sessions.__resetSettingsSessionsForTests();
    store.speichere([{ key: 'CLUB_NAME', wert: null }, { key: 'SITE_PLAYERS', wert: null }, { key: 'SITE_PREVIEW_TOKEN', wert: null }], 'test');
    delete process.env.CLUB_NAME;
  });

  // Jede Anmeldung von einer eigenen Adresse: die Anmeldung ist auf 5 je Minute und Adresse gedrosselt.
  let adresse = 0;
  async function anmelden(): Promise<{ cookie: string; csrf: string }> {
    const res = await fastify.inject({ method: 'POST', url: '/settings/api/login', payload: { user: 'chef', password: PW }, remoteAddress: `198.51.100.${++adresse}` });
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']).split(';')[0];
    return { cookie, csrf: res.json().csrf };
  }

  it('geht vor der Umgebung, und Zurücksetzen gibt sie wieder frei', () => {
    process.env.CLUB_NAME = 'Aus der Umgebung';
    expect(konfig.clubName()).toBe('Aus der Umgebung');
    store.speichere([{ key: 'CLUB_NAME', wert: 'Von der Seite' }], 'test');
    expect(konfig.clubName()).toBe('Von der Seite');
    expect(store.quelleVon('CLUB_NAME')).toBe('seite');
    store.speichere([{ key: 'CLUB_NAME', wert: '' }], 'test');
    expect(konfig.clubName()).toBe('HSG Wölfe Voreifel'); // bewusst leer verdeckt die Umgebung
    store.speichere([{ key: 'CLUB_NAME', wert: null }], 'test');
    expect(konfig.clubName()).toBe('Aus der Umgebung');
    expect(store.quelleVon('CLUB_NAME')).toBe('umgebung');
  });

  it('protokolliert Änderungen und maskiert Geheimnisse', () => {
    store.speichere([{ key: 'SITE_PREVIEW_TOKEN', wert: 'g'.repeat(40) }, { key: 'CLUB_NAME', wert: 'Neu' }], 'chef');
    const zeilen = store.protokoll(10);
    const token = zeilen.find(z => z.key === 'SITE_PREVIEW_TOKEN' && z.action === 'set')!;
    expect(token.new_value).toBe('●●●');
    expect(JSON.stringify(zeilen)).not.toContain('g'.repeat(40));
    expect(zeilen.find(z => z.key === 'CLUB_NAME' && z.new_value === 'Neu')!.actor).toBe('chef');
    expect(store.alsEnvBlock()).toContain('CLUB_NAME=Neu');
    expect(store.alsEnvBlock()).not.toContain('SITE_PREVIEW_TOKEN');
  });

  it('antwortet ohne Anmeldung 401 und mit falschem Passwort 401', async () => {
    expect((await fastify.inject({ method: 'GET', url: '/settings/api/state' })).statusCode).toBe(401);
    const falsch = await fastify.inject({ method: 'POST', url: '/settings/api/login', payload: { user: 'chef', password: 'falsch-falsch-falsch' }, remoteAddress: '203.0.113.10' });
    expect(falsch.statusCode).toBe(401);
    expect(falsch.headers['set-cookie']).toBeUndefined();
    const fremderName = await fastify.inject({ method: 'POST', url: '/settings/api/login', payload: { user: 'admin', password: PW }, remoteAddress: '203.0.113.11' });
    expect(fremderName.statusCode).toBe(401);
  });

  it('setzt ein sicheres Cookie und liefert die Seite ohne Zwischenspeicher', async () => {
    const res = await fastify.inject({ method: 'POST', url: '/settings/api/login', payload: { user: 'chef', password: PW }, remoteAddress: '203.0.113.12' });
    const c = String(res.headers['set-cookie']);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Secure');
    expect(c).toContain('Path=/settings');
    const seite = await fastify.inject({ method: 'GET', url: '/settings' });
    expect(seite.statusCode).toBe(200);
    expect(seite.headers['cache-control']).toBe('no-store');
    expect(seite.body).not.toMatch(/<script>/);
    expect(String(seite.headers['content-security-policy'])).toContain("script-src 'self'");
  });

  it('verlangt für schreibende Aufrufe das CSRF-Token und eine passende Herkunft', async () => {
    const { cookie, csrf } = await anmelden();
    const body = { aenderungen: [{ key: 'CLUB_NAME', wert: 'X' }] };
    const ohne = await fastify.inject({ method: 'PUT', url: '/settings/api/values', headers: { cookie }, payload: body });
    expect(ohne.statusCode).toBe(403);
    const fremd = await fastify.inject({ method: 'PUT', url: '/settings/api/values', headers: { cookie, 'x-csrf-token': csrf, origin: 'https://boese.example' }, payload: body });
    expect(fremd.statusCode).toBe(403);
    const gut = await fastify.inject({ method: 'PUT', url: '/settings/api/values', headers: { cookie, 'x-csrf-token': csrf }, payload: body });
    expect(gut.statusCode).toBe(200);
    expect(konfig.clubName()).toBe('X');
  });

  it('speichert alles oder nichts und meldet Fehler je Feld', async () => {
    const { cookie, csrf } = await anmelden();
    const res = await fastify.inject({
      method: 'PUT', url: '/settings/api/values', headers: { cookie, 'x-csrf-token': csrf },
      payload: { aenderungen: [{ key: 'CLUB_NAME', wert: 'Sollte nicht bleiben' }, { key: 'PRIMARY_COLOR', wert: 'kaputt' }, { key: 'PORT', wert: '1' }] },
    });
    expect(res.statusCode).toBe(422);
    expect(Object.keys(res.json().fehler).sort()).toEqual(['PORT', 'PRIMARY_COLOR']);
    expect(konfig.clubName()).toBe('HSG Wölfe Voreifel');
  });

  it('gibt Geheimnisse nie zurück', async () => {
    const { cookie, csrf } = await anmelden();
    const token = 'z'.repeat(40);
    expect((await fastify.inject({ method: 'PUT', url: '/settings/api/values', headers: { cookie, 'x-csrf-token': csrf }, payload: { aenderungen: [{ key: 'SITE_PREVIEW_TOKEN', wert: token }] } })).statusCode).toBe(200);
    expect(konfig.sitePreviewToken()).toBe(token);
    const state = await fastify.inject({ method: 'GET', url: '/settings/api/state', headers: { cookie } });
    expect(state.body).not.toContain(token);
    const feld = state.json().felder.find((f: { key: string }) => f.key === 'SITE_PREVIEW_TOKEN');
    expect(feld.gesetzt).toBe(true);
    expect(feld.wert).toBe('');
    const exp = await fastify.inject({ method: 'GET', url: '/settings/api/export', headers: { cookie } });
    expect(exp.body).not.toContain(token);
    expect(state.json().geheimnisse.map((g: { key: string }) => g.key)).toContain('TELEGRAM_BOT_TOKEN');
    // Für die Mannschaftszeilen: die Bereiche der Seite und je Mannschaft der automatisch gelesene.
    expect(state.json().bereiche.map((b: { id: string }) => b.id)).toEqual(['herren', 'frauen', 'jungen', 'maedchen', 'kinder']);
    expect(Object.keys(state.json().bereichAutomatisch)).toContain('96254');
    expect(state.json().felder.find((f: { key: string }) => f.key === 'TEAM_GROUPS').versteckt).toBe(true);
  });

  it('leitet zur geheimen Vorschau weiter — nur angemeldet und nur mit Schlüssel', async () => {
    expect((await fastify.inject({ method: 'GET', url: '/settings/vorschau' })).statusCode).toBe(401);
    const { cookie, csrf } = await anmelden();
    expect((await fastify.inject({ method: 'GET', url: '/settings/vorschau', headers: { cookie } })).statusCode).toBe(404);
    expect((await fastify.inject({ method: 'GET', url: '/settings/api/state', headers: { cookie } })).json().vorschau).toBe(false);
    const token = 'v'.repeat(40);
    await fastify.inject({ method: 'PUT', url: '/settings/api/values', headers: { cookie, 'x-csrf-token': csrf }, payload: { aenderungen: [{ key: 'SITE_PREVIEW_TOKEN', wert: token }] } });
    expect((await fastify.inject({ method: 'GET', url: '/settings/api/state', headers: { cookie } })).json().vorschau).toBe(true);
    const res = await fastify.inject({ method: 'GET', url: '/settings/vorschau', headers: { cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`https://handball.test.local/96254/?vorab=${token}`);
    expect(res.headers['cache-control']).toBe('no-store');
    const fremd = await fastify.inject({ method: 'GET', url: '/settings/vorschau?team=999', headers: { cookie } });
    expect(String(fremd.headers.location)).toContain('/96254/');
  });

  it('lehnt eine Anmeldung mit fremder Herkunft ab', async () => {
    const res = await fastify.inject({ method: 'POST', url: '/settings/api/login', headers: { origin: 'https://boese.example' }, payload: { user: 'chef', password: PW }, remoteAddress: '203.0.113.13' });
    expect(res.statusCode).toBe(403);
  });

  it('drosselt die Anmeldung', async () => {
    let letzte = 0;
    for (let i = 0; i < 7; i++) letzte = (await fastify.inject({ method: 'POST', url: '/settings/api/login', payload: { user: 'x', password: 'y' }, remoteAddress: '203.0.113.99' })).statusCode;
    expect(letzte).toBe(429);
  });

  it('meldet sich ab', async () => {
    const { cookie, csrf } = await anmelden();
    expect((await fastify.inject({ method: 'POST', url: '/settings/api/logout', headers: { cookie, 'x-csrf-token': csrf }, payload: {} })).statusCode).toBe(200);
    expect((await fastify.inject({ method: 'GET', url: '/settings/api/state', headers: { cookie } })).statusCode).toBe(401);
  });

  it('prüft live, ohne zu speichern', async () => {
    const { cookie, csrf } = await anmelden();
    const res = await fastify.inject({ method: 'POST', url: '/settings/api/check', headers: { cookie, 'x-csrf-token': csrf }, payload: { aenderungen: [{ key: 'PRIMARY_COLOR', wert: 'rot' }, { key: 'CLUB_NAME', wert: 'Nur geprüft' }] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(Object.keys(res.json().fehler)).toEqual(['PRIMARY_COLOR']);
    expect(konfig.clubName()).toBe('HSG Wölfe Voreifel');
    expect((await fastify.inject({ method: 'POST', url: '/settings/api/check', headers: { cookie }, payload: { aenderungen: [{ key: 'CLUB_NAME', wert: 'x' }] } })).statusCode).toBe(403);
  });

  it('liefert Grenzen der Zahlen und die Herkunft der Geheimnisse', async () => {
    const { cookie } = await anmelden();
    const state = (await fastify.inject({ method: 'GET', url: '/settings/api/state', headers: { cookie } })).json();
    const takt = state.felder.find((f: { key: string }) => f.key === 'SYNC_INTERVAL_MS');
    expect([takt.min, takt.max, takt.nullErlaubt]).toEqual([300_000, 86_400_000, false]);
    expect(state.felder.find((f: { key: string }) => f.key === 'SYNC_LIVE_INTERVAL_MS').nullErlaubt).toBe(true);
    const bot = state.geheimnisse.find((g: { key: string }) => g.key === 'TELEGRAM_BOT_TOKEN');
    expect(bot).toMatchObject({ gesetzt: false, herkunft: null });
    // Früher stand hier immer „gesetzt“ — jetzt nur mit Schlüssel und mit seiner Herkunft.
    const vapid = state.geheimnisse.find((g: { key: string }) => g.key === 'VAPID_PRIVATE_KEY');
    expect(typeof vapid.gesetzt).toBe('boolean');
    if (vapid.gesetzt) expect(vapid.herkunft).toMatch(/Umgebung|Datenbank/);
    expect(state.sitzung.leerlaufMin).toBe(60);
    expect(state.teams).toEqual(['96254']);
  });

  it('blättert und filtert das Protokoll', async () => {
    const { cookie } = await anmelden();
    for (let i = 0; i < 3; i++) store.speichere([{ key: 'CLUB_NAME', wert: `Name ${i}` }], 'chef');
    const alle = (await fastify.inject({ method: 'GET', url: '/settings/api/protokoll', headers: { cookie } })).json();
    expect(alle.anzahl).toBeGreaterThanOrEqual(3);
    const nurName = (await fastify.inject({ method: 'GET', url: '/settings/api/protokoll?key=CLUB_NAME&offset=1', headers: { cookie } })).json();
    expect(nurName.offset).toBe(1);
    expect(nurName.zeilen.every((z: { key: string }) => z.key === 'CLUB_NAME')).toBe(true);
    expect(nurName.zeilen[0].new_value).toBe('Name 1');
    // Unbekannter Schlüssel: kein Filter statt eines Fehlers.
    expect((await fastify.inject({ method: 'GET', url: '/settings/api/protokoll?key=PORT', headers: { cookie } })).json().anzahl).toBe(alle.anzahl);
  });

  it('beendet eine Sitzung nach einer Stunde ohne Zutun; Hintergrund-Abrufe verlängern nicht', async () => {
    const { cookie } = await anmelden();
    sessions.__alterSitzungenForTests(30 * 60_000);
    expect((await fastify.inject({ method: 'GET', url: '/settings/api/state', headers: { cookie, 'x-hintergrund': '1' } })).statusCode).toBe(200);
    sessions.__alterSitzungenForTests(31 * 60_000);
    expect((await fastify.inject({ method: 'GET', url: '/settings/api/state', headers: { cookie } })).statusCode).toBe(401);
    const zweite = await anmelden();
    sessions.__alterSitzungenForTests(50 * 60_000);
    expect((await fastify.inject({ method: 'GET', url: '/settings/api/state', headers: { cookie: zweite.cookie } })).statusCode).toBe(200);
    sessions.__alterSitzungenForTests(50 * 60_000);
    expect((await fastify.inject({ method: 'GET', url: '/settings/api/state', headers: { cookie: zweite.cookie } })).statusCode).toBe(200);
  });

  it('meldet überall ab', async () => {
    const a = await anmelden();
    const b = await anmelden();
    expect(sessions.__anzahlSitzungenForTests()).toBe(2);
    const res = await fastify.inject({ method: 'POST', url: '/settings/api/logout-all', headers: { cookie: a.cookie, 'x-csrf-token': a.csrf }, payload: {} });
    expect(res.json().anzahl).toBe(2);
    expect((await fastify.inject({ method: 'GET', url: '/settings/api/state', headers: { cookie: b.cookie } })).statusCode).toBe(401);
  });

  it('prüft Team-ID, Test-Push und Testnachricht vor jedem Abruf nach außen', async () => {
    expect((await fastify.inject({ method: 'GET', url: '/settings/api/team/96254' })).statusCode).toBe(401);
    const { cookie, csrf } = await anmelden();
    expect((await fastify.inject({ method: 'GET', url: '/settings/api/team/abc', headers: { cookie } })).statusCode).toBe(400);
    const push = await fastify.inject({ method: 'POST', url: '/settings/api/test/push', headers: { cookie, 'x-csrf-token': csrf }, payload: { endpoint: 'x'.repeat(2000), keys: { p256dh: 'a', auth: 'b' } } });
    expect(push.statusCode).toBe(400);
    // Kein bekannter Push-Dienst: wird nicht angefragt.
    const fremd = await fastify.inject({ method: 'POST', url: '/settings/api/test/push', headers: { cookie, 'x-csrf-token': csrf }, payload: { endpoint: 'https://boese.example/push', keys: { p256dh: 'a', auth: 'b' } } });
    expect(fremd.statusCode).toBe(502);
    const tg = await fastify.inject({ method: 'POST', url: '/settings/api/test/telegram', headers: { cookie, 'x-csrf-token': csrf }, payload: {} });
    expect(tg.statusCode).toBe(409);
    expect((await fastify.inject({ method: 'GET', url: '/settings/api/qr.svg', headers: { cookie } })).statusCode).toBe(404);
    const sw = await fastify.inject({ method: 'GET', url: '/settings/sw.js' });
    expect(sw.statusCode).toBe(200);
    expect(sw.body).toContain('showNotification');
  });

  it('gibt es ohne ADMIN_PASSWORD nicht', async () => {
    const alt = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_PASSWORD = 'zu kurz';
    try {
      expect((await fastify.inject({ method: 'GET', url: '/settings' })).statusCode).toBe(404);
      expect((await fastify.inject({ method: 'POST', url: '/settings/api/login', payload: { user: 'chef', password: 'zu kurz' } })).statusCode).toBe(404);
    } finally { process.env.ADMIN_PASSWORD = alt; }
  });

  it('hängt mit ADMIN_PORT nur am eigenen Anschluss', async () => {
    process.env.ADMIN_PORT = '3999';
    try {
      const { buildServer } = await import('../server');
      const oeffentlich = await buildServer({ logger: false });
      await oeffentlich.ready();
      expect((await oeffentlich.inject({ method: 'GET', url: '/settings' })).statusCode).not.toBe(200);
      const admin = await buildServer({ logger: false, adminOnly: true });
      await admin.ready();
      const seite = await admin.inject({ method: 'GET', url: '/settings' });
      expect(seite.statusCode).toBe(200);
      // Über http im LAN darf der Browser das Skript nicht auf https hochstufen (Seite bliebe bei „Lädt …“).
      expect(String(seite.headers['content-security-policy'])).not.toContain('upgrade-insecure-requests');
      expect(String(seite.headers['content-security-policy'])).toContain("script-src 'self'");
      expect(seite.headers['strict-transport-security']).toBeUndefined();
      expect(String((await oeffentlich.inject({ method: 'GET', url: '/healthz' })).headers['content-security-policy'])).toContain('upgrade-insecure-requests');
      expect((await admin.inject({ method: 'GET', url: '/96254/' })).statusCode).toBe(404);
      await oeffentlich.close(); await admin.close();
    } finally { delete process.env.ADMIN_PORT; }
  });
});
