import { describe, it, expect, afterAll } from 'vitest';
import { unlinkSync } from 'fs';
import type { HandballMatchView } from '../lib/handballSicht';
import type { HandballMatchEventItem } from '../lib/handballNetClient';

/**
 * Das Spiel in drei Sätzen (`spielGeschichte`) und der Halbzeitstand aus der
 * gespeicherten Torfolge (`halbzeitAusTorfolge`) — beides reine Rechnung.
 */

const DB_FILE = `/tmp/handball-geschichte-${process.pid}.db`;
process.env.DATABASE_PATH = DB_FILE;

afterAll(() => { try { unlinkSync(DB_FILE); } catch { /* egal */ } });

/** Eine Torfolge aus „h"/„a" je Tor; die Minute steigt gleichmäßig bis `dauer`. */
function torfolge(wer: string, dauer = 60): HandballMatchEventItem[] {
  let home = 0; let away = 0;
  return [...wer].map((z, i) => {
    if (z === 'h') home++; else away++;
    const minute = ((i + 1) * dauer) / wer.length;
    return { minute, home, away, goal: true, block: minute <= dauer / 2 ? '1. Halbzeit' : '2. Halbzeit' };
  });
}

function spiel(events: HandballMatchEventItem[] | null, isHome = true): HandballMatchView {
  const letzter = events?.at(-1);
  return {
    match_id: 'm1', is_home: isHome, home_name: isHome ? 'Wölfe I' : 'TV Gegner', away_name: isHome ? 'TV Gegner' : 'Wölfe I',
    home_id: isHome ? '1' : '2', away_id: isHome ? '2' : '1', status: 'finished',
    score_home: letzter?.home ?? null, score_away: letzter?.away ?? null, events,
  } as unknown as HandballMatchView;
}

describe('Spielgeschichte aus der Torfolge', () => {
  it('nennt den längsten Lauf, die haltende Führung und die Schlussphase', async () => {
    const { spielGeschichte } = await import('../lib/handballSite');
    // 0:2, dann fünf Heimtore in Folge (5:2), danach abwechselnd bis 10:5; am Ende trifft der Gast dreimal.
    const saetze = spielGeschichte(spiel(torfolge('aahhhhhahahahhhaaa')));
    expect(saetze).toEqual([
      'Längster Lauf: 5 Tore in Folge für Wölfe I zwischen der 10. und 24. Minute, von 0:2 auf 5:2.',
      'Die Führung wechselte einmal. Wölfe I ging in der 17. Minute mit 3:2 in Führung und gab sie nicht mehr ab.',
      'Die letzten zehn Minuten gingen mit 3:0 Toren an TV Gegner.',
    ]);
  });

  it('erzählt aus Sicht der eigenen Mannschaft, auch auswärts, und kennt den Start-Ziel-Sieg', async () => {
    const { spielGeschichte } = await import('../lib/handballSite');
    const saetze = spielGeschichte(spiel(torfolge('aaaahahahaha', 50), false));
    expect(saetze[0]).toBe('Längster Lauf: 4 Tore in Folge für Wölfe I zwischen der 5. und 17. Minute, von 0:0 auf 0:4.');
    expect(saetze[1]).toBe('Wölfe I lag vom ersten Tor an vorn.');
  });

  it('nennt bei einem Unentschieden den Ausgleich und lässt ohne brauchbare Torfolge alles weg', async () => {
    const { spielGeschichte, spielGeschichteHtml } = await import('../lib/handballSite');
    expect(spielGeschichte(spiel(torfolge('hahahaha')))).toContain('Der Ausgleich zum 4:4 fiel in der 60. Minute.');
    expect(spielGeschichte(spiel(torfolge('haha')))).toEqual([]);
    expect(spielGeschichte(spiel(null))).toEqual([]);
    expect(spielGeschichteHtml(spiel([]))).toBe('');
    // Ohne Spielminuten: kein Satz zur Schlussphase, der Lauf ohne Zeitangabe.
    const ohneMinute = torfolge('hhhhaaha').map(e => ({ ...e, minute: null }));
    expect(spielGeschichte(spiel(ohneMinute))).toEqual([
      'Längster Lauf: 4 Tore in Folge für Wölfe I, von 0:0 auf 4:0.',
      'Wölfe I lag vom ersten Tor an vorn.',
    ]);
  });
});

describe('Halbzeitstand aus der Torfolge', () => {
  it('ist der Stand am Ende des ersten Blocks — nur, wenn ein zweiter Block belegt ist', async () => {
    const { halbzeitAusTorfolge } = await import('../lib/handballSicht');
    expect(halbzeitAusTorfolge(torfolge('hhahaaha'))).toEqual({ home: 3, away: 1 });
    expect(halbzeitAusTorfolge(torfolge('hhah').map(e => ({ ...e, block: '1. Halbzeit' })))).toBeNull();
    expect(halbzeitAusTorfolge([])).toBeNull();
    expect(halbzeitAusTorfolge(null)).toBeNull();
  });
});
