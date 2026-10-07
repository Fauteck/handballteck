/**
 * Client für handball.net (Wiki „Handball-Verfolgung (handball.net)“).
 *
 * Geprüft wird, was beim Bauen nicht selbstverständlich war: dass die
 * Ortszeit der Quelle richtig nach UTC kommt (Sommer- wie Winterzeit), dass
 * die durchgehend groß geschriebenen Namen lesbar werden, ohne Kürzel zu
 * verlieren, dass das Token aus der Seite gelesen wird und bei 403 einmal
 * frisch geholt wird, und dass eine leere Antwort ein Fehlschlag ist.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
  parseClientToken,
  sourceTimeToUtc,
  schoenerName,
  mapMatch,
  fetchTeamMatches,
  fetchActiveSeason,
  fetchRoster,
  fetchLineups,
  fetchStandings,
  fetchStandingsWithHistory,
  klassifiziereHandballFehler,
  __resetHandballTokenForTests, __resetHandballNetStatsForTests, getHandballNetStats,
  halbzeitAus, chronicleToText, fetchMatchReport, torfolgeAus,
} from '../lib/handballNetClient';

const ORIGINAL_FETCH = global.fetch;
const SEITE = '<html><head><meta name="client-token" content="1790479060167.abc.def"></head></html>';

function antwort(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': typeof body === 'string' ? 'text/html' : 'application/json' },
  });
}

function rohesSpiel(over: Record<string, unknown> = {}) {
  return {
    id: 577132,
    round: 3,
    date: '2026-09-26T15:30:00+00:00',
    status: { id: 1, name: 'Finalizado', is_live: false, is_finished: true },
    phase: {
      id: 12800, name: 'Kreisoberliga mB', season_id: 2627,
      competition: { name: 'Kreisoberliga mB', championship: { name: 'B-JUGEND' } },
    },
    local: { id: 96301, name: 'TV PALMERSHEIM II' },
    visitor: { id: 96254, name: 'HSG WÖLFE VOREIFEL' },
    result: { local: 22, visitor: 30 },
    field: { name: 'PETER-WEBER-HALLE KUCHENHEIM', installation: { address: 'MüNSTERSTRASSE 22/24, 53881 EUSKIRCHEN' } },
    ...over,
  };
}

beforeEach(() => {
  __resetHandballTokenForTests();
  global.fetch = ORIGINAL_FETCH;
});

afterAll(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe('Zeit', () => {
  it('liest die Ziffern der Quelle als Ortszeit — Sommerzeit', () => {
    expect(sourceTimeToUtc('2026-09-26T15:30:00+00:00')).toBe('2026-09-26T13:30:00.000Z');
  });

  it('… und Winterzeit', () => {
    expect(sourceTimeToUtc('2026-11-07T18:00:00+00:00')).toBe('2026-11-07T17:00:00.000Z');
  });

  it('lehnt Unlesbares ab, statt „jetzt" zu nehmen', () => {
    expect(() => sourceTimeToUtc('gestern')).toThrow(/unlesbare Zeitangabe/);
  });
});

describe('Namen', () => {
  it('macht Großschreibung lesbar und lässt Kürzel stehen', () => {
    expect(schoenerName('HSG WÖLFE VOREIFEL')).toBe('HSG Wölfe Voreifel');
    expect(schoenerName('TV PALMERSHEIM II')).toBe('TV Palmersheim II');
    expect(schoenerName('TVE BAD MÜNSTEREIFEL')).toBe('TVE Bad Münstereifel');
    expect(schoenerName('GTV/PHV/BJSG III')).toBe('GTV/PHV/BJSG III');
    expect(schoenerName('PETER-WEBER-HALLE KUCHENHEIM')).toBe('Peter-Weber-Halle Kuchenheim');
  });

  it('fasst nichts an, was schon Kleinbuchstaben hat', () => {
    expect(schoenerName('TuS Niederpleis mB')).toBe('TuS Niederpleis mB');
    expect(schoenerName('HSG Siebengebirge-Thomasberg II')).toBe('HSG Siebengebirge-Thomasberg II');
  });

  it('zählt Umlaute nicht als Kleinbuchstaben — die Quelle schreibt „MüNSTERSTRASSE"', () => {
    expect(schoenerName('MüNSTERSTRASSE 22/24, 53881 EUSKIRCHEN')).toBe('Münsterstrasse 22/24, 53881 Euskirchen');
  });
});

describe('Abbildung', () => {
  it('bildet ein beendetes Spiel samt Halle ab', () => {
    const m = mapMatch(rohesSpiel() as never);
    expect(m.id).toBe('577132');
    expect(m.status).toBe('finished');
    expect(m.startsAt).toBe('2026-09-26T13:30:00.000Z');
    expect(m.homeName).toBe('TV Palmersheim II');
    expect(m.awayName).toBe('HSG Wölfe Voreifel');
    expect(m.scoreHome).toBe(22);
    expect(m.scoreAway).toBe(30);
    expect(m.championshipName).toBe('B-Jugend');
    expect(m.venueName).toBe('Peter-Weber-Halle Kuchenheim');
    expect(m.venueAddress).toBe('Münsterstrasse 22/24, 53881 Euskirchen');
  });

  it('nimmt Koordinaten, Spielberichtsbogen und Vereinslogo mit — Logos nur von den Hosts der Quelle', () => {
    const m = mapMatch(rohesSpiel({
      report: 'https://handball360.isquad.de/dhb_acta_completa_pdf.php?id_partido=577132',
      field: { name: 'HALLE', installation: { address: 'X 1', latitude: '50.6464842', longitude: '6.831915' } },
      local: { id: 96301, name: 'TV PALMERSHEIM II', club: { logo: 'https://handball360.isquad.de/images/afiliacion_clubs/8364/a.jpg' } },
      visitor: { id: 96254, name: 'HSG WÖLFE VOREIFEL', club: { logo: 'https://evil.example/logo.jpg' } },
    }) as never);
    expect(m.venueLat).toBeCloseTo(50.6464842);
    expect(m.venueLon).toBeCloseTo(6.831915);
    expect(m.reportUrl).toContain('dhb_acta_completa_pdf');
    expect(m.homeLogoUrl).toContain('handball360.isquad.de');
    expect(m.awayLogoUrl).toBeNull();
    // Ohne Koordinaten: null, nicht 0.
    expect(mapMatch(rohesSpiel() as never).venueLat).toBeNull();
    expect(mapMatch(rohesSpiel({ field: { installation: { latitude: '0', longitude: '0' } } }) as never).venueLat).toBeNull();
  });

  it('kennt die spanischen und deutschen Statuswörter', () => {
    const status = (name: string, flags: Record<string, boolean> = {}) =>
      mapMatch(rohesSpiel({ status: { id: 0, name, ...flags }, result: null }) as never).status;
    expect(status('Pendiente')).toBe('scheduled');
    expect(status('Verschoben')).toBe('postponed');
    expect(status('Aplazado')).toBe('postponed');
    expect(status('Suspendido')).toBe('cancelled');
    expect(status('En progreso', { is_live: true })).toBe('live');
    expect(status('Finalizado por sancion', { is_finished: true })).toBe('finished');
    expect(status('Irgendwas Neues')).toBe('other');
  });
});

describe('Token und Abruf', () => {
  it('liest das Token aus der Seite', () => {
    expect(parseClientToken(SEITE)).toBe('1790479060167.abc.def');
    expect(parseClientToken('<html></html>')).toBeNull();
  });

  it('holt erst die Seite, dann die API mit dem Token — und behält das Token', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(antwort(SEITE))
      .mockResolvedValueOnce(antwort({ data: [{ id: 2627, name: 'Saison 2026/2027', is_active: true }] }))
      .mockResolvedValueOnce(antwort({ data: [rohesSpiel()] }));
    global.fetch = f as unknown as typeof fetch;

    const saison = await fetchActiveSeason();
    expect(saison.id).toBe(2627);
    const spiele = await fetchTeamMatches('96254', 2627);
    expect(spiele).toHaveLength(1);

    // Seite + zwei API-Aufrufe — kein zweites Laden der Seite.
    expect(f).toHaveBeenCalledTimes(3);
    const apiInit = f.mock.calls[1][1] as RequestInit;
    expect((apiInit.headers as Record<string, string>)['x-client-token']).toBe('1790479060167.abc.def');
    expect(String(f.mock.calls[2][0])).toContain('team_id=96254');
  });

  it('holt bei 403 einmal ein frisches Token und gibt dann auf', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(antwort(SEITE))
      .mockResolvedValueOnce(antwort({ error: 'Forbidden' }, 403))
      .mockResolvedValueOnce(antwort(SEITE))
      .mockResolvedValueOnce(antwort({ error: 'Forbidden' }, 403));
    global.fetch = f as unknown as typeof fetch;

    await expect(fetchActiveSeason()).rejects.toMatchObject({ name: 'HandballBlockedError' });
    expect(f).toHaveBeenCalledTimes(4);
  });

  it('meldet eine Seite ohne Token als Fehlschlag', async () => {
    global.fetch = vi.fn().mockResolvedValue(antwort('<html>neu gebaut</html>')) as unknown as typeof fetch;
    await expect(fetchActiveSeason()).rejects.toMatchObject({ name: 'HandballEmptyError' });
  });

  it('nimmt null Spiele nicht als spielfreie Saison', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(antwort(SEITE))
      .mockResolvedValueOnce(antwort({ data: [] })) as unknown as typeof fetch;
    await expect(fetchTeamMatches('123', 2627)).rejects.toMatchObject({ name: 'HandballEmptyError' });
  });

  it('scheitert laut, wenn die Antwort nicht mehr die erwartete Gestalt hat', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(
      String(url).includes('/api/new/') ? antwort({ data: [{ id: 1, datum: '2026-09-26' }] }) : antwort(SEITE),
    )) as unknown as typeof fetch;
    const err = await fetchTeamMatches('96254', 2627).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('HandballEmptyError');
    expect((err as Error).message).toContain('/api/new/matches');
    expect((err as Error).message).toContain('data.0.date');
    expect(klassifiziereHandballFehler(err)).toBe('auth_error');
  });

  it('zählt Abrufe, Fehlschläge und den letzten Erfolg', async () => {
    __resetHandballNetStatsForTests();
    global.fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(
      String(url).includes('/api/new/') ? antwort({ data: [{ id: 2627, name: 's', is_active: true }] }) : antwort(SEITE),
    )) as unknown as typeof fetch;
    await fetchActiveSeason();
    expect(getHandballNetStats()).toMatchObject({ requests: 1, failures: 0 });
    expect(getHandballNetStats().last_ok_at).not.toBeNull();
    global.fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(
      String(url).includes('/api/new/') ? antwort({ error: 'x' }, 500) : antwort(SEITE),
    )) as unknown as typeof fetch;
    await fetchActiveSeason().catch(() => undefined);
    expect(getHandballNetStats()).toMatchObject({ requests: 2, failures: 1 });
  });

  it('ordnet Leere und Sperre dem Zugang zu, alles andere dem Vorübergehenden', () => {
    const e = (name: string) => Object.assign(new Error('x'), { name });
    expect(klassifiziereHandballFehler(e('HandballBlockedError'))).toBe('auth_error');
    expect(klassifiziereHandballFehler(e('HandballEmptyError'))).toBe('auth_error');
    expect(klassifiziereHandballFehler(e('HandballTransientError'))).toBe('transient_error');
    expect(klassifiziereHandballFehler(new Error('HTTP 418'))).toBe('transient_error');
  });
});

describe('Kader und Aufstellung', () => {
  it('liest den Kader mit Namen, Nummer und Rolle', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(antwort(SEITE))
      .mockResolvedValueOnce(antwort({ data: [
        { dorsal: '25', rol: { id: 0, name: 'SPIELER' }, user: { id: '0qzndy7', first_name: 'Eskil', last_name: 'Lieck' } },
        { dorsal: null, rol: { id: 0, name: 'SPIELER' }, user: { id: '0uficne', first_name: 'Simon', last_name: 'Heinemann' } },
        { dorsal: null, rol: { id: 1, name: 'TRAINER' }, user: { id: '0szu0lx', first_name: 'Frank', last_name: 'Kalenborn' } },
      ] })) as unknown as typeof fetch;
    const kader = await fetchRoster('96254', 2627);
    expect(kader).toEqual([
      { playerId: '0qzndy7', firstName: 'Eskil', lastName: 'Lieck', number: 25, role: 'player' },
      { playerId: '0uficne', firstName: 'Simon', lastName: 'Heinemann', number: null, role: 'player' },
      { playerId: '0szu0lx', firstName: 'Frank', lastName: 'Kalenborn', number: null, role: 'staff' },
    ]);
  });

  it('trägt die Spieler-ID der Aufstellung mit — die Brücke zum Kader', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(antwort(SEITE))
      .mockResolvedValueOnce(antwort({ data: {
        local: { team: { id: 96254, name: 'HSG WÖLFE VOREIFEL' }, players: [
          { player: { id: '0qzndy7', first_name: '*', last_name: '*' }, number: 25, is_captain: true, goals: 7, seven_meter_goals: 1 },
          { player: { id: '0szu0lx' }, number: 0, is_staff: true },
        ], staff: [{ is_staff: true }] },
        visitor: { team: { id: 96301, name: 'TV PALMERSHEIM II' }, players: [], staff: [] },
      } })) as unknown as typeof fetch;
    const lu = await fetchLineups('577132');
    expect(lu.home.players).toEqual([{ playerId: '0qzndy7', number: 25, isGoalkeeper: false, isCaptain: true, goals: 7, sevenMeterGoals: 1, sevenMeterAttempts: 0, twoMinutes: 0 }]);
    expect(lu.home.staffCount).toBe(1);
  });
});

describe('Tabelle', () => {
  it('behält nur den jüngsten Spieltag — die Quelle liefert eine Tabelle je Spieltag', async () => {
    const zeile = (round: number, position: number, name: string, points: number) => ({
      round, position, team: { id: position, name }, played: round, won: 0, drawn: 0, lost: 0,
      goals_for: 0, goals_against: 0, goals_diff: 0, points,
    });
    global.fetch = vi.fn()
      .mockResolvedValueOnce(antwort(SEITE))
      .mockResolvedValueOnce(antwort({ data: [
        zeile(1, 1, 'A', 2), zeile(1, 2, 'B', 0),
        zeile(3, 1, 'B', 4), zeile(3, 2, 'A', 2),
        zeile(2, 1, 'A', 2), zeile(2, 2, 'B', 2),
      ] })) as unknown as typeof fetch;
    const rows = await fetchStandings(12800, 2627);
    expect(rows.map(r => `${r.round}:${r.position}:${r.teamName}:${r.points}`)).toEqual(['3:1:B:4', '3:2:A:2']);
  });

  it('behält die gespielten Spieltage als Verlauf und wirft die wiederholten weg', async () => {
    const zeile = (round: number, position: number, name: string, played: number, points: number) => ({
      round, position, team: { id: name === 'A' ? 1 : 2, name }, played, won: 0, drawn: 0, lost: 0,
      goals_for: 0, goals_against: 0, goals_diff: 0, points,
    });
    global.fetch = vi.fn()
      .mockResolvedValueOnce(antwort(SEITE))
      .mockResolvedValueOnce(antwort({ data: [
        zeile(1, 1, 'A', 1, 2), zeile(1, 2, 'B', 1, 0),
        zeile(2, 1, 'B', 2, 2), zeile(2, 2, 'A', 2, 2),
        // Spieltag 3 und 4: noch nicht gespielt, wiederholen den Stand nach dem zweiten.
        zeile(3, 1, 'B', 2, 2), zeile(3, 2, 'A', 2, 2),
        zeile(4, 1, 'B', 2, 2), zeile(4, 2, 'A', 2, 2),
      ] })) as unknown as typeof fetch;
    const { current, history } = await fetchStandingsWithHistory(12800, 2627);
    expect(current.map(r => `${r.round}:${r.position}:${r.teamName}`)).toEqual(['2:1:B', '2:2:A']);
    expect(history.map(r => `${r.round}:${r.position}:${r.teamName}`)).toEqual(['1:1:A', '1:2:B', '2:1:B', '2:2:A']);
  });
});

describe('Torfolge und Spielbericht', () => {
  const tor = (block: string, local: number, visitor: number, name = 'Tor') => ({ block, event_type: { name, is_goal: true }, score: { local, visitor } });

  it('liest den Halbzeitstand erst, wenn die zweite Halbzeit begonnen hat', () => {
    // Läuft noch: kein Halbzeitstand, aber der jüngste Stand.
    const laeuft = halbzeitAus([tor(' 1. Halbzeit', 1, 0), tor(' 1. Halbzeit', 13, 12)]);
    expect(laeuft.halftime).toBeNull();
    expect(laeuft.latest).toEqual({ home: 13, away: 12 });
    expect(laeuft.count).toBe(2);
    // Zweite Halbzeit da: der letzte Stand des ersten Blocks ist die Halbzeit.
    const pause = halbzeitAus([tor(' 1. Halbzeit', 13, 12), tor(' 2. Halbzeit', 14, 12)]);
    expect(pause.halftime).toEqual({ home: 13, away: 12 });
    // Oder ein „Ende"-Ereignis im ersten Block.
    const ende = halbzeitAus([tor(' 1. Halbzeit', 13, 12), tor(' 1. Halbzeit', 13, 12, 'Ende Teil')]);
    expect(ende.halftime).toEqual({ home: 13, away: 12 });
    expect(halbzeitAus([]).halftime).toBeNull();
    // Dieselbe Torfolge als Liste für den Spielverlauf: Minute über beide Halbzeiten, Stand, Tor ja/nein; ohne Stand fällt ein Ereignis weg.
    const liste = torfolgeAus([tor(' 1. Halbzeit', 1, 0), { minute: '03:00', block: ' 2. Halbzeit', event_type: { id: 9, name: '2 Minuten', is_goal: false }, score: { local: 1, visitor: 0 } }, { minute: '04:00', block: ' 2. Halbzeit' }]);
    expect(liste).toHaveLength(2);
    expect(liste[0]).toMatchObject({ home: 1, away: 0, block: '1. Halbzeit' });
    expect(liste[1]).toMatchObject({ minute: 28, home: 1, away: 0, goal: false, block: '2. Halbzeit' });
  });

  it('macht aus dem HTML-Bericht Absätze mit „## "-Zwischenüberschriften, ohne die h1', () => {
    const text = chronicleToText('<h1>Spielbericht: A vs. B</h1>\n<h2>Erste Halbzeit</h2>\n<p>Das Spiel begann <b>schnell</b> &amp; laut.</p><p>Zweiter Absatz.</p>');
    expect(text).toBe('## Erste Halbzeit\n\nDas Spiel begann schnell & laut.\n\nZweiter Absatz.');
    expect(chronicleToText('nur Text &lt;ohne&gt; Tags')).toBe('nur Text <ohne> Tags');
  });

  it('holt den Bericht aus additional-info und gibt null, solange keiner da ist', async () => {
    let chronicle: string | null = null;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (!String(url).includes('/api/new/')) return Promise.resolve(antwort(SEITE));
      return Promise.resolve(antwort({ data: [{ chronicle }] }));
    }) as unknown as typeof fetch;
    expect(await fetchMatchReport('577132')).toBeNull();
    chronicle = '<h2>Erste Halbzeit</h2><p>Los.</p>';
    expect(await fetchMatchReport('577132')).toBe('## Erste Halbzeit\n\nLos.');
  });
});
