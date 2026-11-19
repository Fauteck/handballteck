import { describe, it, expect, afterAll } from 'vitest';
import { unlinkSync } from 'fs';
import type { HandballTeamView } from '../lib/handballSicht';

/** Die Abfahrtstafel: welche Spiele sie zeigt (`tafelZeilen`) — reine Rechnung über die Übersicht. */

const DB_FILE = `/tmp/handball-tafel-${process.pid}.db`;
process.env.DATABASE_PATH = DB_FILE;

afterAll(() => { try { unlinkSync(DB_FILE); } catch { /* egal */ } });

/** Mittwoch, 18.11.2026, 12:00 Uhr in Deutschland. */
const JETZT = new Date('2026-11-18T12:00:00+01:00');
const in_ = (stunden: number) => new Date(JETZT.getTime() + stunden * 3_600_000).toISOString();

function team(id: string, spiele: Array<[string, number, string, boolean?]>): HandballTeamView {
  return {
    team_id: id, label: `Team ${id}`,
    matches: spiele.map(([match_id, stunden, status, is_live]) => ({ match_id, starts_at: in_(stunden), status, is_live: is_live === true })),
  } as unknown as HandballTeamView;
}

describe('Abfahrtstafel', () => {
  it('zeigt heute alles, danach die nächsten Anwürfe in zeitlicher Folge — auch unter der Woche und über Mannschaften hinweg', async () => {
    const { tafelZeilen } = await import('../lib/handballSitePages');
    const zeilen = tafelZeilen([
      team('1', [['alt', -72, 'finished'], ['heute-fertig', -2, 'finished'], ['donnerstag', 30, 'scheduled'], ['samstag', 76, 'scheduled']]),
      team('2', [['heute-abend', 7, 'scheduled'], ['freitag-verlegt', 55, 'postponed'], ['verlegt-ohne-termin', -30, 'postponed']]),
    ], JETZT);
    expect(zeilen.map(z => z.m.match_id)).toEqual(['heute-fertig', 'heute-abend', 'donnerstag', 'freitag-verlegt', 'samstag']);
  });

  it('füllt bis zur Zeilenzahl auf, kürzt die Spiele von heute nie und behält ein laufendes Spiel von gestern Abend', async () => {
    const { tafelZeilen } = await import('../lib/handballSitePages');
    const viele = Array.from({ length: 20 }, (_, i): [string, number, string] => [`k${i}`, 24 + i * 24, 'scheduled']);
    expect(tafelZeilen([team('1', viele)], JETZT).map(z => z.m.match_id)).toEqual(viele.slice(0, 12).map(v => v[0]));
    const heute = Array.from({ length: 5 }, (_, i): [string, number, string] => [`h${i}`, i, 'scheduled']);
    const zeilen = tafelZeilen([team('1', [...heute, ...viele]), team('2', [['laeuft', -13, 'scheduled', true]])], JETZT, 3);
    expect(zeilen.map(z => z.m.match_id)).toEqual(['laeuft', 'h0', 'h1', 'h2', 'h3', 'h4']);
    expect(tafelZeilen([], JETZT)).toEqual([]);
  });
});
