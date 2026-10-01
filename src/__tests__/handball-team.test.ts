/**
 * Handball-Verfolgung (docs/handball-verfolgung.md): der Job und seine
 * zwei Meldungen.
 *
 * Geprüft wird, was in Betrieb peinlich würde: dass ohne Team-ID nichts
 * abgerufen wird, dass der Tageslauf einmal holt und danach ruht, und dass
 * eine leere Antwort als Ausfall an den Betreiber gemeldet wird. Die zwei
 * Anlässe für Todoteck-Nutzer (Ankündigung, Endstand) meldet seit dem Umzug
 * Todoteck selbst aus `GET /api/overview` — die Tests dazu liegen dort.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { unlinkSync } from 'fs';

const DB_FILE = `/tmp/handball-test-${process.pid}.db`;
process.env.DATABASE_PATH = DB_FILE;
process.env.PUBLIC_URL = 'https://todo.test.local';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_INVITE_CODE;
delete process.env.TELEGRAM_ADMIN_CHAT_IDS;
delete process.env.TEAM_IDS;
delete process.env.PRIMARY_COLOR; delete process.env.SECONDARY_COLOR; delete process.env.ACCENT_COLOR;
delete process.env.SITE_URL; delete process.env.SITE_PLAYERS; delete process.env.SITE_ENABLED;
delete process.env.SITE_OPERATOR; delete process.env.SITE_FEEDBACK_MAIL;

const TEAM = '96254';

let dbRef: typeof import('../db')['db'];
let schemaRef: typeof import('../db/schema');
let mod: typeof import('../lib/handballTeam');
let alerts: typeof import('../lib/alerts');
let resetToken: () => void;
const ORIGINAL_FETCH = global.fetch;

const SEITE = '<html><head><meta name="client-token" content="tok.abc"></head></html>';

function antwort(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': typeof body === 'string' ? 'text/html' : 'application/json' },
  });
}

/** Die Quelle schreibt Ortszeit mit +00:00 — hier also die Berliner Wandzeit erzeugen. */
function quellzeit(ms: number): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).reduce<Record<string, string>>((acc, x) => { acc[x.type] = x.value; return acc; }, {});
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+00:00`;
}

function spiel(over: Record<string, unknown> = {}) {
  return {
    id: 577138,
    round: 4,
    date: quellzeit(Date.now() + 3 * 60 * 60 * 1000),
    status: { id: 2, name: 'Pendiente', is_live: false, is_finished: false },
    phase: { id: 12800, name: 'Kreisoberliga mB', season_id: 2627, competition: { name: 'Kreisoberliga mB', championship: { name: 'B-JUGEND' } } },
    local: { id: 96254, name: 'HSG WÖLFE VOREIFEL' },
    visitor: { id: 96300, name: 'HV ERFTSTADT' },
    result: { local: null, visitor: null },
    field: { name: 'SPORTHALLE HEIMERZHEIM', installation: { address: 'SCHULSTRASSE 1, 53913 SWISTTAL' } },
    ...over,
  };
}

const TABELLE = { data: [
  { position: 1, team: { id: 96254, name: 'HSG WÖLFE VOREIFEL' }, played: 3, won: 3, drawn: 0, lost: 0, goals_for: 106, goals_against: 87, goals_diff: 19, points: 6 },
  { position: 2, team: { id: 96300, name: 'HV ERFTSTADT' }, played: 3, won: 2, drawn: 0, lost: 1, goals_for: 80, goals_against: 70, goals_diff: 10, points: 4 },
] };

/** Ein fetch, der Seite, Saison, Spiele und Tabelle bedient und die API-Aufrufe zählt. */
function quelle(spiele: unknown[] = [spiel()]) {
  const f = vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    if (!u.includes('/api/new/')) return Promise.resolve(antwort(SEITE));
    if (u.includes('/seasons')) return Promise.resolve(antwort({ data: [{ id: 2627, name: 'Saison 2026/2027', is_active: true }] }));
    if (u.includes('/matches?')) return Promise.resolve(antwort({ data: spiele }));
    if (u.includes('/standings?')) return Promise.resolve(antwort(TABELLE));
    if (u.includes('/roster?')) return Promise.resolve(antwort({ data: [
      { dorsal: '25', rol: { id: 0, name: 'SPIELER' }, user: { id: 'p-lieck', first_name: 'Eskil', last_name: 'Lieck' } },
      { dorsal: null, rol: { id: 1, name: 'TRAINER' }, user: { id: 'p-kalenborn', first_name: 'Frank', last_name: 'Kalenborn' } },
    ] }));
    return Promise.resolve(antwort({ error: 'nope' }, 404));
  });
  global.fetch = f as unknown as typeof fetch;
  return f;
}

function apiAufrufe(f: ReturnType<typeof vi.fn>): number {
  return f.mock.calls.filter(c => String(c[0]).includes('/api/new/')).length;
}

function trageTeamEin(ids = TEAM) {
  process.env.TEAM_IDS = ids;
}

/** Die Meldungen an den Betreiber (lib/alerts.ts) — statt Todotecks `sync_error`. */
const betreiber: Array<{ chatId: string; text: string }> = [];
function erlaube(): void {
  process.env.TELEGRAM_BOT_TOKEN = '123:test';
  process.env.TELEGRAM_ADMIN_CHAT_IDS = '4711';
}

function legeSpiel(over: Partial<Record<string, unknown>> = {}) {
  const startsAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  dbRef.insert(schemaRef.handball_team_match).values({
    id: `${TEAM}:m1`, team_id: TEAM, match_id: 'm1', season_id: 2627,
    starts_at: startsAt, status: 'scheduled', status_name: 'Pendiente', round: 4, phase_id: 12800,
    competition_name: 'Kreisoberliga mB', championship_name: 'B-Jugend',
    home_id: TEAM, home_name: 'HSG Wölfe Voreifel', away_id: '96300', away_name: 'HV Erftstadt',
    score_home: null, score_away: null, venue_name: 'Sporthalle Heimerzheim', venue_address: 'Schulstrasse 1',
    notified_upcoming: false, notified_result: false, updated_at: new Date().toISOString(),
    ...over,
  } as never).run();
}

beforeAll(async () => {
  const { runMigrations } = await import('../db/migrate');
  const { db } = await import('../db');
  const schema = await import('../db/schema');
  const { __resetHandballTokenForTests } = await import('../lib/handballNetClient');
  mod = await import('../lib/handballTeam');
  alerts = await import('../lib/alerts');
  runMigrations();
  dbRef = db;
  schemaRef = schema;
  resetToken = __resetHandballTokenForTests;
});

afterAll(() => {
  global.fetch = ORIGINAL_FETCH;
  try { unlinkSync(DB_FILE); } catch { /* egal */ }
});

beforeEach(() => {
  resetToken();
  global.fetch = ORIGINAL_FETCH;
  dbRef.delete(schemaRef.handball_team_match).run();
  dbRef.delete(schemaRef.handball_standings).run();
  dbRef.delete(schemaRef.handball_roster).run();
  dbRef.delete(schemaRef.handball_match_player).run();
  dbRef.delete(schemaRef.handball_match_change).run();
  dbRef.delete(schemaRef.handball_team_logo).run();
  delete process.env.TEAM_IDS;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ADMIN_CHAT_IDS;
  betreiber.length = 0;
  alerts.__resetAlertsForTests();
});

describe('Konfiguration', () => {
  it('liest Team-IDs in jeder üblichen Schreibweise', () => {
    expect(mod.parseTeamIds('96254')).toEqual(['96254']);
    expect(mod.parseTeamIds('96254, 96301\n96254')).toEqual(['96254', '96301']);
    expect(mod.parseTeamIds('/team/96254')).toEqual([]);
    expect(mod.parseTeamIds(undefined)).toEqual([]);
  });

  it('ruft ohne Mannschaft gar nichts ab', async () => {
    const f = quelle();
    const r = await mod.syncHandballTeams();
    expect(r.status).toBe('not_configured');
    expect(f).not.toHaveBeenCalled();
    expect(mod.handballOverview().configured).toBe(false);
  });
});

describe('Tageslauf', () => {
  it('holt Saison, Spielplan und Tabelle — und danach am selben Tag nichts mehr', async () => {
    trageTeamEin();
    const f = quelle();
    const erster = await mod.syncHandballTeams();
    expect(erster.status).toBe('ok');
    // Saison + Spiele + Tabelle + Kader + Spielplan des nächsten Gegners (§7.5).
    expect(apiAufrufe(f)).toBe(5);
    expect(mod.opponentFormFor('96300')?.matches).toHaveLength(1);
    expect(mod.rosterFor(TEAM).map(r => `${r.number ?? '-'} ${r.name} ${r.role}`)).toEqual(['25 Eskil Lieck player', '- Frank Kalenborn staff']);

    const sicht = mod.handballOverview();
    expect(sicht.configured).toBe(true);
    expect(sicht.teams[0].name).toBe('HSG Wölfe Voreifel');
    expect(sicht.teams[0].next_match?.venue_name).toBe('Sporthalle Heimerzheim');
    expect(sicht.teams[0].standings[0].rows[0].teamName).toBe('HSG Wölfe Voreifel');

    f.mockClear();
    const zweiter = await mod.syncHandballTeams();
    expect(zweiter.status).toBe('ok');
    expect(apiAufrufe(f)).toBe(0);
  });

  it('holt eine später eingetragene Mannschaft noch am selben Tag', async () => {
    trageTeamEin();
    quelle();
    await mod.syncHandballTeams();

    trageTeamEin(`${TEAM},75796`);
    const f = quelle([spiel({ id: 600001, local: { id: 75796, name: 'HSG WÖLFE VOREIFEL II' } })]);
    const r = await mod.syncHandballTeams();
    expect(r.status).toBe('ok');
    const teams = f.mock.calls.map(c => String(c[0])).filter(u => u.includes('/matches?')).map(u => new URL(u).searchParams.get('team_id'));
    // Nur die neue Mannschaft und der Spielplan ihres Gegners — die erste ruht.
    expect(teams).toEqual(['75796', '96300']);
    expect(mod.handballOverview().teams.find(t => t.team_id === '75796')?.next_match).toBeTruthy();
  });

  it('fragt keinen Spielplan für einen Gegner ohne ID ab (Testspiel)', async () => {
    trageTeamEin();
    const f = quelle([spiel({ visitor: { id: 0, name: 'GASTMANNSCHAFT' } })]);
    expect((await mod.syncHandballTeams()).status).toBe('ok');
    expect(f.mock.calls.map(c => String(c[0])).filter(u => u.includes('team_id=0&'))).toEqual([]);
  });

  it('holt die übrigen Mannschaften, wenn eine Team-ID nichts liefert', async () => {
    trageTeamEin(`11111,${TEAM}`);
    const sonst = quelle().getMockImplementation()!;
    const f = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/matches?') && u.includes('team_id=11111')) return Promise.resolve(antwort({ data: [] }));
      return sonst(url);
    });
    global.fetch = f as unknown as typeof fetch;
    const r = await mod.syncHandballTeams();
    expect(r.status).toBe('auth_error');
    expect(r.detail).toContain('11111');
    expect(mod.handballOverview().teams.find(t => t.team_id === TEAM)?.next_match).toBeTruthy();
  });

  it('fasst am Spieltag nach und holt nach dem Abpfiff die Tabelle einmal neu', async () => {
    trageTeamEin();
    // Der Tageslauf gilt als erledigt (Zeile von heute); das Spiel lief vor einer Stunde an.
    legeSpiel({ starts_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    const f = quelle([spiel({
      id: 'm1',
      date: quellzeit(Date.now() - 60 * 60 * 1000),
      status: { id: 1, name: 'Finalizado', is_live: false, is_finished: true },
      result: { local: 31, visitor: 25 },
    })]);
    const r = await mod.syncHandballTeams();
    expect(r.status).toBe('ok');
    // Spiele + Tabelle, keine Saison.
    expect(apiAufrufe(f)).toBe(2);
    const zeile = dbRef.select().from(schemaRef.handball_team_match).all()[0];
    expect(zeile.status).toBe('finished');
    expect(zeile.score_home).toBe(31);
  });

  it('meldet null Spiele als Ausfall — nicht als spielfreie Saison', async () => {
    trageTeamEin();
    erlaube();
    const f = quelle([]);
    const r = await mod.syncHandballTeams();
    expect(r.status).toBe('auth_error');
    // Die Meldung geht an die Admin-Chats des Bots: ein sendMessage an Telegram.
    const telegram = f.mock.calls.filter(c => String(c[0]).includes('api.telegram.org')).map(c => JSON.parse(String((c[1] as { body: string }).body)) as { chat_id: string; text: string });
    expect(telegram).toHaveLength(1);
    expect(telegram[0].chat_id).toBe('4711');
    expect(telegram[0].text).toContain('Zugangsfehler');
    // Derselbe Fehler noch einmal: keine zweite Meldung.
    await mod.syncHandballTeams(true);
    expect(f.mock.calls.filter(c => String(c[0]).includes('api.telegram.org'))).toHaveLength(1);
  });
});

describe('Verlegungen', () => {
  const jetzt = Date.now();
  const inZwei = new Date(jetzt + 2 * 24 * 60 * 60 * 1000).toISOString();
  const inDrei = new Date(jetzt + 3 * 24 * 60 * 60 * 1000).toISOString();

  it('erkennt neuen Termin, Verschiebung ohne Termin und Absage — und nichts an Beendetem oder Altem', () => {
    expect(mod.erkenneAenderung({ status: 'scheduled', starts_at: inZwei }, { status: 'scheduled', startsAt: inDrei }, jetzt)).toBe('rescheduled');
    expect(mod.erkenneAenderung({ status: 'scheduled', starts_at: inZwei }, { status: 'postponed', startsAt: inZwei }, jetzt)).toBe('postponed');
    expect(mod.erkenneAenderung({ status: 'postponed', starts_at: inZwei }, { status: 'scheduled', startsAt: inDrei }, jetzt)).toBe('rescheduled');
    expect(mod.erkenneAenderung({ status: 'scheduled', starts_at: inZwei }, { status: 'cancelled', startsAt: inZwei }, jetzt)).toBe('cancelled');
    expect(mod.erkenneAenderung({ status: 'scheduled', starts_at: inZwei }, { status: 'scheduled', startsAt: inZwei }, jetzt)).toBeNull();
    expect(mod.erkenneAenderung({ status: 'postponed', starts_at: inZwei }, { status: 'postponed', startsAt: inZwei }, jetzt)).toBeNull();
    expect(mod.erkenneAenderung({ status: 'finished', starts_at: inZwei }, { status: 'finished', startsAt: inDrei }, jetzt)).toBeNull();
    const alt = new Date(jetzt - 5 * 24 * 60 * 60 * 1000).toISOString();
    const nochAelter = new Date(jetzt - 6 * 24 * 60 * 60 * 1000).toISOString();
    expect(mod.erkenneAenderung({ status: 'scheduled', starts_at: alt }, { status: 'scheduled', startsAt: nochAelter }, jetzt)).toBeNull();
  });

  it('schreibt die Verlegung beim Abruf als Verlaufszeile', async () => {
    trageTeamEin();
    legeSpiel({ id: `${TEAM}:577138`, match_id: '577138', starts_at: inZwei, updated_at: '2020-01-01T00:00:00.000Z' });
    quelle([spiel({ date: quellzeit(Date.parse(inDrei)) })]);
    await mod.syncHandballTeams();
    const changes = mod.changesFor(TEAM);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ match_id: '577138', kind: 'rescheduled', old_starts_at: inZwei });
    // Ein zweiter Lauf mit denselben Daten schreibt keine zweite Zeile.
    await mod.syncHandballTeams(true);
    expect(mod.changesFor(TEAM)).toHaveLength(1);
  });
});

describe('Aufstellungen und Bilanz', () => {
  const seite = (players: Array<Partial<{ playerId: string; number: number; goals: number; sevenMeterGoals: number; sevenMeterAttempts: number; twoMinutes: number }>>) => ({
    teamId: TEAM, teamName: 'HSG Wölfe Voreifel', staffCount: 1,
    players: players.map(p => ({ playerId: 'x', number: 0, isGoalkeeper: false, isCaptain: false, goals: 0, sevenMeterGoals: 0, sevenMeterAttempts: 0, twoMinutes: 0, ...p })),
  });

  it('summiert die Saison je Spieler aus den gespeicherten Aufstellungen, Namen aus dem Kader', () => {
    const now = new Date().toISOString();
    dbRef.insert(schemaRef.handball_roster).values({ id: `${TEAM}:p-lieck`, team_id: TEAM, player_id: 'p-lieck', first_name: 'Eskil', last_name: 'Lieck', number: 25, role: 'player', season_id: 2627, updated_at: now }).run();
    legeSpiel({ id: `${TEAM}:m1`, match_id: 'm1', status: 'finished' });
    legeSpiel({ id: `${TEAM}:m2`, match_id: 'm2', status: 'finished' });
    mod.storeLineup(TEAM, 'm1', seite([{ playerId: 'p-lieck', number: 25, goals: 7, sevenMeterGoals: 1, sevenMeterAttempts: 2 }, { playerId: 'p-fremd', number: 22, goals: 2 }]));
    mod.storeLineup(TEAM, 'm2', seite([{ playerId: 'p-lieck', number: 24, goals: 4, twoMinutes: 1 }]));
    // Noch einmal dasselbe Spiel: kein Doppelzählen.
    mod.storeLineup(TEAM, 'm2', seite([{ playerId: 'p-lieck', number: 24, goals: 4, twoMinutes: 1 }]));
    const stats = mod.playerStats(TEAM);
    expect(stats[0]).toMatchObject({ name: 'Eskil Lieck', number: 24, games: 2, goals: 11, sevenMeterGoals: 1, sevenMeterAttempts: 2, twoMinutes: 1 });
    expect(stats[1]).toMatchObject({ name: 'Nr. 22', games: 1, goals: 2 });
    const m2 = dbRef.select().from(schemaRef.handball_team_match).all().find(r => r.match_id === 'm2')!;
    expect(m2.lineup_stored_at).not.toBeNull();
  });

  it('holt fehlende Aufstellungen auch, wenn der Tageslauf heute schon lief', async () => {
    trageTeamEin();
    // Zeile von heute → der Tageslauf gilt als gelaufen; die Aufstellung fehlt trotzdem.
    legeSpiel({ status: 'finished', score_home: 30, score_away: 22, starts_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() });
    const f = quelle();
    f.mockImplementation((url: string) => {
      const u = String(url);
      if (!u.includes('/api/new/')) return Promise.resolve(antwort(SEITE));
      if (u.includes('/lineups')) {
        return Promise.resolve(antwort({ data: { local: { team: { id: 96254, name: 'HSG WÖLFE VOREIFEL' }, players: [{ player: { id: 'p-lieck' }, number: 25, goals: 5 }], staff: [] }, visitor: { team: { id: 96300, name: 'HV ERFTSTADT' }, players: [], staff: [] } } }));
      }
      return Promise.resolve(antwort({ error: 'nope' }, 404));
    });
    const r = await mod.syncHandballTeams();
    expect(r.status).toBe('ok');
    expect(f.mock.calls.filter(c => String(c[0]).includes('/seasons'))).toHaveLength(0);
    expect(f.mock.calls.filter(c => String(c[0]).includes('/lineups'))).toHaveLength(1);
    expect(mod.playerStats(TEAM)[0]).toMatchObject({ goals: 5, games: 1 });
  });

  it('holt im Tageslauf die Aufstellungen beendeter Spiele nach — je Spiel einmal', async () => {
    trageTeamEin();
    const f = quelle([spiel({ status: { id: 1, name: 'Finalizado', is_live: false, is_finished: true }, result: { local: 30, visitor: 22 }, date: quellzeit(Date.now() - 3 * 24 * 60 * 60 * 1000) })]);
    f.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/lineups')) {
        return Promise.resolve(antwort({ data: { local: { team: { id: 96254, name: 'HSG WÖLFE VOREIFEL' }, players: [{ player: { id: 'p-lieck' }, number: 25, goals: 5 }], staff: [] }, visitor: { team: { id: 96300, name: 'HV ERFTSTADT' }, players: [], staff: [] } } }));
      }
      if (!u.includes('/api/new/')) return Promise.resolve(antwort(SEITE));
      if (u.includes('/seasons')) return Promise.resolve(antwort({ data: [{ id: 2627, name: 'S', is_active: true }] }));
      if (u.includes('/matches?')) return Promise.resolve(antwort({ data: [spiel({ status: { id: 1, name: 'Finalizado', is_live: false, is_finished: true }, result: { local: 30, visitor: 22 }, date: quellzeit(Date.now() - 3 * 24 * 60 * 60 * 1000) })] }));
      if (u.includes('/standings?')) return Promise.resolve(antwort(TABELLE));
      return Promise.resolve(antwort({ error: 'nope' }, 404));
    });
    await mod.syncHandballTeams();
    expect(f.mock.calls.filter(c => String(c[0]).includes('/lineups'))).toHaveLength(1);
    expect(mod.playerStats(TEAM)[0]).toMatchObject({ goals: 5, games: 1 });
    await mod.syncHandballTeams(true);
    expect(f.mock.calls.filter(c => String(c[0]).includes('/lineups'))).toHaveLength(1);
    expect(mod.logoDataUri(TEAM)).toBeNull();
    // Ein gespeichertes Logo — auch das eines Gegners — kommt als Data-URI.
    dbRef.insert(schemaRef.handball_team_logo).values({ team_id: '96300', source_url: 'https://handball360.isquad.de/x.jpg', mime_type: 'image/jpeg', image: Buffer.from([1, 2, 3]), fetched_at: new Date().toISOString() }).run();
    expect(mod.logoDataUri('96300')).toBe('data:image/jpeg;base64,AQID');
    // Die Logo-URLs beider Seiten stehen am Spiel.
    const zeile = dbRef.select().from(schemaRef.handball_team_match).all()[0];
    expect(zeile).toMatchObject({ home_logo_url: null, away_logo_url: null });
  });
});

describe('Tabellenstand davor', () => {
  it('behält beim Wechsel der Tabelle den Stand davor, bei unverändertem Abruf nicht', async () => {
    trageTeamEin();
    quelle();
    await mod.syncHandballTeams(true);
    let t = dbRef.select().from(schemaRef.handball_standings).all()[0];
    expect(t.previous_payload).toBeNull();
    await mod.syncHandballTeams(true);
    t = dbRef.select().from(schemaRef.handball_standings).all()[0];
    expect(t.previous_payload).toBeNull();
    const f = quelle();
    f.mockImplementation((url: string) => {
      const u = String(url);
      if (!u.includes('/api/new/')) return Promise.resolve(antwort(SEITE));
      if (u.includes('/seasons')) return Promise.resolve(antwort({ data: [{ id: 2627, name: 'S', is_active: true }] }));
      if (u.includes('/matches?')) return Promise.resolve(antwort({ data: [spiel()] }));
      if (u.includes('/standings?')) return Promise.resolve(antwort({ data: TABELLE.data.map(r => ({ ...r, round: 4, played: 4 })) }));
      return Promise.resolve(antwort({ error: 'nope' }, 404));
    });
    await mod.syncHandballTeams(true);
    t = dbRef.select().from(schemaRef.handball_standings).all()[0];
    expect(t.previous_payload).not.toBeNull();
    expect(mod.handballOverview().teams[0].standings[0].previous_rows?.[0].played).toBe(3);
    expect(mod.handballOverview().teams[0].standings[0].rows[0].played).toBe(4);
    expect(mod.backlogFor(TEAM)).toEqual({ lineupsMissing: 0, logosMissing: 0 });
  });
});

describe('Torfolge, Spielbericht und Gegner-Spielplan für die Microsite', () => {
  const EVENTS = { data: [
    { minute: '02:10', global_minute: 2.2, block: ' 1. Halbzeit', event_type: { id: 1, name: 'Tor', is_goal: true }, score: { local: 1, visitor: 0 } },
    { minute: '05:00', global_minute: 5, block: ' 1. Halbzeit', event_type: { id: 9, name: '2 Minuten', is_goal: false }, score: { local: 1, visitor: 0 } },
    { minute: '07:30', global_minute: 7.5, block: ' 1. Halbzeit', event_type: { id: 1, name: 'Tor', is_goal: true }, score: { local: 1, visitor: 1 } },
  ] };

  it('holt die Torfolge beendeter Spiele in jedem Takt nach, ein 404 wird als leer gespeichert', async () => {
    trageTeamEin();
    const vorGestern = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    legeSpiel({ status: 'finished', score_home: 30, score_away: 22, starts_at: vorGestern, lineup_stored_at: vorGestern });
    dbRef.insert(schemaRef.handball_team_match).values({
      id: `${TEAM}:m2`, team_id: TEAM, match_id: 'm2', season_id: 2627, starts_at: vorGestern, status: 'finished', status_name: 'Finalizado', round: 3, phase_id: 12800,
      competition_name: 'Kreisoberliga mB', championship_name: 'B-Jugend', home_id: '96300', home_name: 'HV Erftstadt', away_id: TEAM, away_name: 'HSG Wölfe Voreifel',
      score_home: 20, score_away: 25, lineup_stored_at: vorGestern, notified_upcoming: true, notified_result: true, updated_at: new Date().toISOString(),
    } as never).run();
    const f = quelle();
    f.mockImplementation((url: string) => {
      const u = String(url);
      if (!u.includes('/api/new/')) return Promise.resolve(antwort(SEITE));
      if (u.includes('/matches/m1/events')) return Promise.resolve(antwort(EVENTS));
      return Promise.resolve(antwort({ error: 'nope' }, 404));
    });
    await mod.syncHandballTeams();
    const sicht = mod.handballOverview().teams[0];
    const m1 = sicht.matches.find(m => m.match_id === 'm1')!;
    const m2 = sicht.matches.find(m => m.match_id === 'm2')!;
    expect(m1.events?.map(e => [e.minute, e.home, e.away, e.goal])).toEqual([[2.2, 1, 0, true], [5, 1, 0, false], [7.5, 1, 1, true]]);
    // Kein zweiter Abruf für m1, keiner mehr für m2 (404 → `[]`): Beim nächsten Takt kostet die Torfolge nichts.
    expect(m2.events).toEqual([]);
    f.mockClear();
    await mod.syncHandballTeams();
    expect(f.mock.calls.filter(c => String(c[0]).includes('/events')).length).toBe(0);
  });

  it('holt Spielberichte im Tageslauf nach — nur für Spiele der letzten 30 Tage', async () => {
    trageTeamEin();
    const vorGestern = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const vorZweiMonaten = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    dbRef.insert(schemaRef.handball_team_match).values([
      { id: `${TEAM}:alt`, team_id: TEAM, match_id: 'alt', season_id: 2627, starts_at: vorZweiMonaten, status: 'finished', status_name: 'Finalizado', round: 1, phase_id: 12800,
        competition_name: 'Kreisoberliga mB', championship_name: 'B-Jugend', home_id: TEAM, home_name: 'HSG Wölfe Voreifel', away_id: '96300', away_name: 'HV Erftstadt',
        score_home: 30, score_away: 22, lineup_stored_at: vorZweiMonaten, events_payload: '[]', notified_upcoming: true, notified_result: true, updated_at: vorZweiMonaten },
      { id: `${TEAM}:neu`, team_id: TEAM, match_id: 'neu', season_id: 2627, starts_at: vorGestern, status: 'finished', status_name: 'Finalizado', round: 3, phase_id: 12800,
        competition_name: 'Kreisoberliga mB', championship_name: 'B-Jugend', home_id: TEAM, home_name: 'HSG Wölfe Voreifel', away_id: '96300', away_name: 'HV Erftstadt',
        score_home: 30, score_away: 22, lineup_stored_at: vorGestern, events_payload: '[]', notified_upcoming: true, notified_result: true, updated_at: vorZweiMonaten },
    ] as never).run();
    const f = quelle([]);
    f.mockImplementation((url: string) => {
      const u = String(url);
      if (!u.includes('/api/new/')) return Promise.resolve(antwort(SEITE));
      if (u.includes('/seasons')) return Promise.resolve(antwort({ data: [{ id: 2627, name: 'S', is_active: true }] }));
      if (u.includes('/matches?')) return Promise.resolve(antwort({ data: [spiel()] }));
      if (u.includes('/standings?')) return Promise.resolve(antwort(TABELLE));
      if (u.includes('/additional-info')) return Promise.resolve(antwort({ data: [{ chronicle: '<h1>Spielbericht</h1><p>Ein klarer Sieg.</p>' }] }));
      return Promise.resolve(antwort({ error: 'nope' }, 404));
    });
    await mod.syncHandballTeams();
    const berichte = f.mock.calls.map(c => String(c[0])).filter(u => u.includes('/additional-info'));
    expect(berichte).toHaveLength(1);
    expect(berichte[0]).toContain('/matches/neu/');
    expect(mod.handballOverview().teams[0].matches.find(m => m.match_id === 'neu')?.report_text).toBe('Ein klarer Sieg.');
  });
});

describe('Tendenz-Referenz', () => {
  const zeile = (round: number, position: number, teamId: string) => ({
    round, position, teamId, teamName: teamId, played: round, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalsDiff: 0, points: 0,
  });
  const sicht = (rows: ReturnType<typeof zeile>[], history: ReturnType<typeof zeile>[], previous: ReturnType<typeof zeile>[] | null = null) => ({
    phase_id: 1, competition_name: 'K', fetched_at: '', rows, previous_rows: previous, history_rows: history,
  });

  it('misst am Stand nach dem vorigen Spieltag, nicht am letzten geänderten Abruf', () => {
    // 28.09.2026: Die Wölfe spielten Samstag, der Erste erst Sonntag — dazwischen standen sie kurz auf 1.
    // Gegen diesen Zwischenstand (previous_rows) wäre der Sonntag ein ▼; gegen den 2. Spieltag ist es ein Verharren.
    const history = [zeile(1, 1, 'GTV'), zeile(1, 2, 'HSG'), zeile(2, 1, 'GTV'), zeile(2, 2, 'HSG'), zeile(3, 1, 'GTV'), zeile(3, 2, 'HSG')];
    const s = sicht([zeile(3, 1, 'GTV'), zeile(3, 2, 'HSG')], history, [zeile(3, 1, 'HSG'), zeile(3, 2, 'GTV')]);
    const ref = mod.tendenzReferenz(s);
    expect(ref?.map(r => [r.round, r.position, r.teamId])).toEqual([[2, 1, 'GTV'], [2, 2, 'HSG']]);
  });

  it('gibt null ohne vorigen Spieltag und ohne Verlauf', () => {
    expect(mod.tendenzReferenz(sicht([zeile(1, 1, 'A')], [zeile(1, 1, 'A')]))).toBeNull();
    expect(mod.tendenzReferenz(sicht([zeile(3, 1, 'A')], []))).toBeNull();
    // Verlauf da, aber ohne den vorigen Spieltag (Lücke): ebenfalls null statt eines falschen Vergleichs.
    expect(mod.tendenzReferenz(sicht([zeile(3, 1, 'A')], [zeile(1, 1, 'A')]))).toBeNull();
  });
});

describe('Tabelle im Altbestand', () => {
  it('setzt den Spieltag auf die gespielten Spiele — ein alter Schnappschuss mit round 18 sagt 3', () => {
    const rows = mod.normalisiereTabelle([
      { round: 18, position: 1, teamId: 'a', teamName: 'A', played: 3, won: 3, drawn: 0, lost: 0, goalsFor: 1, goalsAgainst: 0, goalsDiff: 1, points: 6 },
      { round: 18, position: 2, teamId: 'b', teamName: 'B', played: 2, won: 0, drawn: 0, lost: 2, goalsFor: 0, goalsAgainst: 1, goalsDiff: -1, points: 0 },
    ]);
    expect(rows.map(r => r.round)).toEqual([3, 3]);
  });

  it('bringt einen 180-Zeilen-Schnappschuss ohne `round` auf den jüngsten Spieltag', () => {
    const zeile = (position: number, teamId: string, played: number) => ({
      position, teamId, teamName: `Team ${teamId}`, played, won: played, drawn: 0, lost: 0,
      goalsFor: 0, goalsAgainst: 0, goalsDiff: 0, points: played * 2,
    });
    // Drei Spieltage à zwei Mannschaften, wie die Quelle sie liefert — ohne `round`.
    const alt = [
      zeile(1, 'a', 1), zeile(2, 'b', 1),
      zeile(1, 'b', 2), zeile(2, 'a', 2),
      zeile(1, 'a', 3), zeile(2, 'b', 3),
      zeile(1, 'a', 3), zeile(2, 'b', 3),
    ] as never[];
    const rows = mod.normalisiereTabelle(alt);
    expect(rows.map(r => `${r.position}:${r.teamId}:${r.played}`)).toEqual(['1:a:3', '2:b:3']);
  });

  it('nimmt bei neuen Schnappschüssen den höchsten `round`', () => {
    const zeile = (round: number, position: number, teamId: string) => ({
      round, position, teamId, teamName: teamId, played: round, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalsDiff: 0, points: 0,
    });
    const rows = mod.normalisiereTabelle([zeile(2, 1, 'a'), zeile(2, 2, 'b'), zeile(1, 1, 'b'), zeile(1, 2, 'a')]);
    expect(rows.map(r => `${r.round}:${r.position}:${r.teamId}`)).toEqual(['2:1:a', '2:2:b']);
  });
});

describe('Zeitzonen-Selbsttest', () => {
  const t0 = Date.parse('2026-10-03T12:45:00.000Z');
  const min = (n: number) => new Date(t0 + n * 60_000).toISOString();

  it('urteilt aus der Torfolge: unter 15 min bestätigt, eine Stunde daneben Verdacht mit Richtung', () => {
    expect(mod.pruefeZeitzone({ startsAt: min(0), kickoffEstimatedAt: min(8) })).toEqual({ urteil: 'confirmed', abweichungMin: 8, grundlage: 'torfolge' });
    expect(mod.pruefeZeitzone({ startsAt: min(0), kickoffEstimatedAt: min(62) })).toMatchObject({ urteil: 'suspect_late', abweichungMin: 62 });
    expect(mod.pruefeZeitzone({ startsAt: min(0), kickoffEstimatedAt: min(-60) })).toMatchObject({ urteil: 'suspect_early', abweichungMin: -60 });
    // Sommerzeit: ein falsch gelesenes Etikett wären zwei Stunden.
    expect(mod.pruefeZeitzone({ startsAt: min(0), kickoffEstimatedAt: min(121) })).toMatchObject({ urteil: 'suspect_late' });
    // Dazwischen und darüber hinaus: kein Urteil.
    expect(mod.pruefeZeitzone({ startsAt: min(0), kickoffEstimatedAt: min(30) }).urteil).toBe('inconclusive');
    expect(mod.pruefeZeitzone({ startsAt: min(0), kickoffEstimatedAt: min(200) }).urteil).toBe('inconclusive');
  });

  it('urteilt ohne Torfolge aus dem Statuswechsel — nur bei engem Fenster', () => {
    // Zuletzt unbeendet +60, zuerst beendet +75: Mitte +67,5, minus 70 → -2,5 min.
    expect(mod.pruefeZeitzone({ startsAt: min(0), unfinishedSeenAt: min(60), finishedSeenAt: min(75) }))
      .toMatchObject({ urteil: 'confirmed', grundlage: 'statuswechsel' });
    // Eine Stunde später beendet als erwartet.
    expect(mod.pruefeZeitzone({ startsAt: min(0), unfinishedSeenAt: min(120), finishedSeenAt: min(135) }))
      .toMatchObject({ urteil: 'suspect_late', grundlage: 'statuswechsel' });
    // Fenster über 40 Minuten (Tageslauf am Morgen, dann erst am Abend beendet gesehen): nichts.
    expect(mod.pruefeZeitzone({ startsAt: min(0), unfinishedSeenAt: min(-300), finishedSeenAt: min(75) }))
      .toEqual({ urteil: 'inconclusive', abweichungMin: null, grundlage: null });
    expect(mod.pruefeZeitzone({ startsAt: min(0) }).grundlage).toBeNull();
    // Die Torfolge gewinnt vor dem Statuswechsel.
    expect(mod.pruefeZeitzone({ startsAt: min(0), kickoffEstimatedAt: min(3), unfinishedSeenAt: min(120), finishedSeenAt: min(135) }).grundlage).toBe('torfolge');
  });

  it('schätzt den Anwurf aus der Spieluhr und behält die früheste Schätzung', () => {
    legeSpiel({ starts_at: new Date(Date.now() - 30 * 60_000).toISOString(), status: 'live' });
    const jetzt = new Date();
    const events = { halftime: null, latest: { home: 5, away: 4 }, latestMinute: '20:00', latestBlock: '1. Halbzeit', latestGlobalMinute: 20, count: 9 };
    mod.merkeAnwurfSchaetzung(TEAM, 'm1', events, jetzt);
    const erste = dbRef.select().from(schemaRef.handball_team_match).all()[0].kickoff_estimated_at!;
    expect(Date.parse(erste)).toBe(jetzt.getTime() - 20 * 60_000);
    // Eine spätere, schlechtere Schätzung überschreibt nicht.
    mod.merkeAnwurfSchaetzung(TEAM, 'm1', { ...events, latestGlobalMinute: 5 }, jetzt);
    expect(dbRef.select().from(schemaRef.handball_team_match).all()[0].kickoff_estimated_at).toBe(erste);
    // Eine leere Torfolge sagt nichts.
    dbRef.update(schemaRef.handball_team_match).set({ kickoff_estimated_at: null }).run();
    mod.merkeAnwurfSchaetzung(TEAM, 'm1', { ...events, count: 0 }, jetzt);
    expect(dbRef.select().from(schemaRef.handball_team_match).all()[0].kickoff_estimated_at).toBeNull();
  });

  it('merkt beim Wechsel auf beendet das Urteil, meldet einen Verdacht einmal an den Betreiber und /status liest ihn', async () => {
    trageTeamEin();
    erlaube();
    const start = Date.now() - 135 * 60_000;
    // Anwurf laut Quelle vor 135 min; zuletzt unbeendet vor 10 min, jetzt beendet → beobachtet vor 75 min: eine Stunde später.
    legeSpiel({ starts_at: new Date(start).toISOString(), status: 'live', unfinished_seen_at: new Date(Date.now() - 10 * 60_000).toISOString() });
    const f = quelle([spiel({ id: 'm1', date: quellzeit(start), status: { id: 1, name: 'Finalizado', is_live: false, is_finished: true }, result: { local: 31, visitor: 25 } })]);
    const telegram = () => f.mock.calls.filter(c => String(c[0]).includes('api.telegram.org')).map(c => JSON.parse(String((c[1] as { body: string }).body)) as { text: string });
    expect(mod.zeitzonenStand().stand).toBe('ungeprüft');
    await mod.syncHandballTeams();
    const zeile = dbRef.select().from(schemaRef.handball_team_match).all()[0];
    expect(zeile.finished_seen_at).not.toBeNull();
    expect(zeile.tz_check).toBe('suspect_late');
    expect(telegram()).toHaveLength(1);
    expect(telegram()[0].text).toContain('Zeitzonen-Lesart vermutlich falsch');
    expect(telegram()[0].text).toContain('min hinter dem gespeicherten Anwurf');
    expect(mod.zeitzonenStand()).toMatchObject({ stand: 'Verdacht' });
    expect(mod.zeitzonenStand().detail).toContain('später als gespeichert');
    // Ein zweiter Lauf urteilt nicht erneut und meldet nichts mehr.
    await mod.syncHandballTeams(true);
    expect(telegram()).toHaveLength(1);
  });

  it('bestätigt ein pünktliches Spiel ohne Meldung', async () => {
    trageTeamEin();
    erlaube();
    const start = Date.now() - 75 * 60_000;
    legeSpiel({ starts_at: new Date(start).toISOString(), status: 'live', unfinished_seen_at: new Date(Date.now() - 12 * 60_000).toISOString() });
    const f = quelle([spiel({ id: 'm1', date: quellzeit(start), status: { id: 1, name: 'Finalizado', is_live: false, is_finished: true }, result: { local: 31, visitor: 25 } })]);
    await mod.syncHandballTeams();
    expect(dbRef.select().from(schemaRef.handball_team_match).all()[0].tz_check).toBe('confirmed');
    expect(f.mock.calls.filter(c => String(c[0]).includes('api.telegram.org'))).toHaveLength(0);
    expect(mod.zeitzonenStand()).toEqual({ stand: 'bestätigt', detail: 'an 1 Spiel' });
  });
});

describe('Abbruch und Wertung', () => {
  const vorTagen = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const zeile = (over: Partial<{ match_id: string; status: string; starts_at: string; phase_id: number | null; score_home: number | null; score_away: number | null }>) => ({
    match_id: 'x', status: 'finished', starts_at: vorTagen(7), phase_id: 12800, score_home: 30, score_away: 22, ...over,
  });
  const tabelle = (played: number) => [{ phase_id: 12800, rows: [{ round: played, position: 1, teamId: TEAM, teamName: 'HSG', played, won: played, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalsDiff: 0, points: 2 * played }] }];

  it('erkennt „other" mit Toren als gewertet, ohne Tore nur über die Tabelle', () => {
    const mitToren = [zeile({ match_id: 'a' }), zeile({ match_id: 'b', status: 'other', score_home: 0, score_away: 20 })];
    expect([...mod.gewerteteSpiele(TEAM, mitToren, tabelle(2))]).toEqual(['b']);
    const ohneToren = [zeile({ match_id: 'a' }), zeile({ match_id: 'b', status: 'cancelled', score_home: null, score_away: null, starts_at: vorTagen(3) })];
    expect(mod.gewerteteSpiele(TEAM, ohneToren, tabelle(1)).size).toBe(0);
    expect([...mod.gewerteteSpiele(TEAM, ohneToren, tabelle(2))]).toEqual(['b']);
    // Ein künftiges Spiel ist nie gewertet.
    expect(mod.gewerteteSpiele(TEAM, [zeile({ match_id: 'c', status: 'other', starts_at: new Date(Date.now() + 86_400_000).toISOString() })], []).size).toBe(0);
  });

  it('führt ein gewertetes Spiel in der Sicht als gewertet und gewonnen — die Absage mit Ergebnis nicht als Absage', async () => {
    trageTeamEin();
    legeSpiel({ starts_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), status: 'other', status_name: 'Abgebrochen', score_home: 20, score_away: 0 });
    const sicht = mod.handballOverview().teams[0];
    expect(sicht.matches[0]).toMatchObject({ rated: true, won: true });
    expect(sicht.last_match?.match_id).toBe('m1');
    const inZwei = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect(mod.erkenneAenderung({ status: 'scheduled', starts_at: inZwei }, { status: 'cancelled', startsAt: inZwei, scoreHome: 0, scoreAway: 20 }, Date.now())).toBeNull();
  });
});

describe('Saisonende', () => {
  const view = (status: string, tageHer: number, rated = false) => ({ status, starts_at: new Date(Date.now() - tageHer * 86_400_000).toISOString(), rated }) as never;

  it('ist nicht vorbei, solange ein Spiel angesetzt oder verschoben ist', () => {
    expect(mod.saisonVorbei({ matches: [view('finished', 20), view('scheduled', -3)] })).toMatchObject({ vorbei: false, frisch: false });
    expect(mod.saisonVorbei({ matches: [view('finished', 20), view('postponed', 10)] }).vorbei).toBe(false);
    expect(mod.saisonVorbei({ matches: [] }).vorbei).toBe(false);
    // Nur Absagen: keine Saison, die man bilanzieren könnte.
    expect(mod.saisonVorbei({ matches: [view('cancelled', 3)] }).vorbei).toBe(false);
  });

  it('ist vorbei und frisch, wenn alles beendet, gewertet oder abgesetzt ist und das letzte Spiel höchstens sieben Tage her ist', () => {
    expect(mod.saisonVorbei({ matches: [view('finished', 30), view('other', 10, true), view('cancelled', 1), view('finished', 3)] }))
      .toMatchObject({ vorbei: true, frisch: true });
  });

  it('ist vorbei, aber nicht mehr frisch, wenn das letzte Spiel älter als sieben Tage ist', () => {
    expect(mod.saisonVorbei({ matches: [view('finished', 30), view('finished', 8)] })).toMatchObject({ vorbei: true, frisch: false });
  });
});

describe('Vereinsfarben und Mannschaften aus der Umgebung', () => {
  it('liest nur gültige Farben', () => {
    process.env.PRIMARY_COLOR = '#8B0000'; process.env.SECONDARY_COLOR = 'kaputt'; process.env.ACCENT_COLOR = '#ffd700';
    try {
      expect(mod.readPalette()).toEqual({ primary: '#8b0000', secondary: undefined, accent: '#ffd700' });
    } finally {
      delete process.env.PRIMARY_COLOR; delete process.env.SECONDARY_COLOR; delete process.env.ACCENT_COLOR;
    }
  });

  it('liest Namen hinter dem Gleichheitszeichen und bezeichnet gleichnamige Mannschaften nach Altersklasse', async () => {
    const { parseTeamEntries } = await import('../config');
    expect(parseTeamEntries('96254=B-Jugend, 96300=C-Jugend')).toEqual([{ id: '96254', label: 'B-Jugend' }, { id: '96300', label: 'C-Jugend' }]);
    expect(parseTeamEntries('96254 96300')).toEqual([{ id: '96254', label: null }, { id: '96300', label: null }]);
    trageTeamEin('96254,96300');
    legeSpiel({ championship_name: 'B-Jugend' });
    legeSpiel({ id: '96300:m2', match_id: 'm2', team_id: '96300', home_id: '96300', championship_name: 'C-Jugend' });
    const sicht = mod.handballOverview();
    expect(sicht.teams.map(t => t.label)).toEqual(['B-Jugend', 'C-Jugend']);
    // Gleicher Vereinsname: der Name der Mannschaft trägt die Altersklasse, damit /spiele sie unterscheidet.
    expect(sicht.teams.map(t => t.name)).toEqual(['HSG Wölfe Voreifel B-Jugend', 'HSG Wölfe Voreifel C-Jugend']);
    trageTeamEin('96254=Wölfe B, 96300');
    expect(mod.handballOverview().teams.map(t => t.label)).toEqual(['Wölfe B', 'C-Jugend']);
  });
});
