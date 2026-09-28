/**
 * Die Handball-Tabelle und der Kader als Bild (docs/handball-verfolgung.md §5).
 */

import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  renderStandingsSvg, renderRosterSvg, renderResultSvg, renderFixtureSvg, renderPositionChartSvg, renderScorersSvg, renderPlayerChartSvg, renderSeasonSummarySvg, renderPng, renderGif, logoAccentColor, __nameMaxWidthForTests,
  themeFor, vervollstaendigePalette, istHexFarbe, DEFAULT_PALETTE, zeilenAusNamen,
} from '../lib/handballTableImage';

const zeile = (position: number, teamId: string, teamName: string, points: number) => ({
  round: 3, position, teamId, teamName, played: 3, won: position === 1 ? 3 : 1, drawn: 0, lost: position === 1 ? 0 : 2,
  goalsFor: 100, goalsAgainst: 90, goalsDiff: 10, points,
});

describe('Tabelle als Bild', () => {
  it('zeichnet jede Zeile, hebt die eigene hervor und kürzt lange Namen', () => {
    const svg = renderStandingsSvg({
      competitionName: 'Kreisoberliga mB',
      ownTeamId: '96254',
      subtitle: 'B-Jugend · nach dem 3. Spieltag',
      rows: [
        zeile(2, '96249', 'HSG Siebengebirge-Thomasberg II mit einem viel zu langen Namen', 4),
        zeile(1, '96254', 'HSG Wölfe Voreifel', 6),
      ],
    });
    expect(svg).toContain('Kreisoberliga mB');
    expect(svg).toContain('nach dem 3. Spieltag');
    expect(svg).toContain('HSG Wölfe Voreifel');
    // Ohne Logo die Initialen im Kreis, mit Logo das Bild.
    expect(svg).toContain('>HS</text>');
    const mitLogo = renderStandingsSvg({ competitionName: 'K', ownTeamId: '96254', rows: [zeile(1, '96254', 'HSG Wölfe Voreifel', 6)], logos: { '96254': 'data:image/png;base64,L' }, brand: { botHandle: '@Bot', stand: 'jetzt' } });
    expect(mitLogo).toContain('<image href="data:image/png;base64,L"');
    expect(mitLogo).toContain('Stand: jetzt');
    expect(mitLogo).toContain('@Bot · Telegram-Bot');
    // Sortiert nach Platz: die Wölfe stehen vor Siebengebirge.
    expect(svg.indexOf('Wölfe')).toBeLessThan(svg.indexOf('Siebengebirge'));
    // Eigene Zeile: Türkis-Balken im Vereins-CD.
    expect(svg).toContain('fill="#0bdbd6"');
    // Der lange Name ist gekürzt — und die Kürzung passt in die Spalte.
    const m = /HSG Siebengebirge[^<]*…/.exec(svg);
    expect(m).not.toBeNull();
    const { NAME_MAX_WIDTH, ROW_SIZE, estimateTextWidth } = __nameMaxWidthForTests;
    expect(estimateTextWidth(m![0], ROW_SIZE)).toBeLessThanOrEqual(NAME_MAX_WIDTH);
    expect(svg).not.toContain('viel zu langen');
  });

  it('rastert zu einem PNG in doppelter Breite', async () => {
    const svg = renderStandingsSvg({ competitionName: 'Test', ownTeamId: '1', rows: [zeile(1, '1', 'A', 2), zeile(2, '2', 'B', 0)] });
    const png = await renderPng(svg);
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // Breite steht in den Bytes 16–19 des IHDR-Chunks.
    expect(png.readUInt32BE(16)).toBe(1600);
  });
});

describe('Kader als Bild', () => {
  it('verteilt die Spieler auf zwei Spalten, zeigt Stab und Fußnote und kürzt lange Namen', () => {
    const players: Array<{ number: number | null; name: string; goalkeeper?: boolean; numberFromLineup?: boolean }> = Array.from({ length: 15 }, (_, i) => ({ number: i + 1, name: `Spieler ${i + 1}` }));
    players.push({ number: null, name: 'Maximilian-Alexander von und zu Siebengebirge-Thomasberg' });
    players[0] = { ...players[0], goalkeeper: true };
    players[1] = { ...players[1], numberFromLineup: true };
    const svg = renderRosterSvg({
      teamName: 'HSG Wölfe Voreifel',
      subtitle: 'B-Jugend · Kader · 16 Spieler',
      players,
      staff: ['Frank Kalenborn'],
      footnote: 'Nummern laut Kader — am Spieltag werden sie manchmal getauscht.',
    });
    expect(svg).toContain('HSG Wölfe Voreifel');
    expect(svg).toContain('>KADER</text>');
    expect(svg).toContain('>16 SPIELER</text>');
    expect(svg).toContain('>TRAINER</text>');
    expect(svg).toContain('Frank Kalenborn');
    expect(svg).toContain('manchmal getauscht');
    // Ohne Nummer steht ein Strich.
    expect(svg).toContain('>–</text>');
    // Torwart-Marke; die Nummer aus der Aufstellung auf dunklem Trikot statt auf dem Verlauf.
    expect(svg).toContain('>TW</text>');
    expect((svg.match(/fill="url\(#trikot\)"/g) ?? []).length).toBe(15);
    expect((svg.match(/fill="#015069" stroke="#ffffff"/g) ?? []).length).toBe(1);
    // Kapitän: die Marke „C" nur, wenn gesetzt.
    expect(svg).not.toContain('>C</text>');
    expect(renderRosterSvg({ teamName: 'T', players: [{ number: 25, name: 'Eskil Lieck', captain: true }], staff: [] })).toContain('>C</text>');
    // Der lange Name ist gekürzt und passt in die Spalte.
    const m = /Maximilian-Alexander[^<]*…/.exec(svg);
    expect(m).not.toBeNull();
    const { ROSTER_NAME_MAX_WIDTH, ROW_SIZE, estimateTextWidth } = __nameMaxWidthForTests;
    expect(estimateTextWidth(m![0], ROW_SIZE)).toBeLessThanOrEqual(ROSTER_NAME_MAX_WIDTH);
    // Spieler 9 beginnt die zweite Spalte: gleiche Höhe wie Spieler 1, andere x-Position.
    const pos = (name: string) => {
      const m = new RegExp(`x="([\\d.]+)" y="([\\d.]+)"[^>]*>${name}</text>`).exec(svg)!;
      return { x: Number(m[1]), y: Number(m[2]) };
    };
    const y = (name: string) => pos(name).y;
    const x = (name: string) => pos(name).x;
    expect(y('Spieler 9')).toBe(y('Spieler 1'));
    expect(x('Spieler 9')).toBeGreaterThan(x('Spieler 1'));
  });

  it('schreibt drei Trainer aus, über die volle Breite und bei Bedarf in zwei Zeilen', () => {
    // Am 28.09.2026 stand „Tobias Wiemken · Frank Kalenborn · F…" im Bild: eine Zeile auf halber Breite.
    const staff = ['Tobias Wiemken', 'Frank Kalenborn', 'Friedrich-Wilhelm von Siebengebirge-Thomasberg', 'Anna-Lena Müller-Lüdenscheidt'];
    const svg = renderRosterSvg({ teamName: 'HSG Wölfe Voreifel', players: [{ number: 1, name: 'A' }], staff, footnote: 'Fußnote' });
    for (const name of staff) expect(svg).toContain(name);
    expect(svg).not.toContain('…');
    expect(svg).toContain('>TRAINER / BETREUER</text>');
    // Die Zeilen des Stabs stehen untereinander, die Fußnote darunter.
    const y = (text: string) => Number(new RegExp(`y="([\\d.]+)"[^>]*>[^<]*${text}[^<]*</text>`).exec(svg)![1]);
    expect(y('Tobias Wiemken')).toBeLessThan(y('Anna-Lena')); 
    expect(y('Anna-Lena')).toBeLessThan(y('Fußnote'));
    // Der Umbruch fällt zwischen zwei Namen; ein Name allein, der nicht passt, wird gekürzt.
    expect(zeilenAusNamen(['Anna', 'Bert'], 17, 1000)).toEqual(['Anna · Bert']);
    expect(zeilenAusNamen(['Anna Anna Anna', 'Bert Bert Bert'], 17, 180)).toEqual(['Anna Anna Anna', 'Bert Bert Bert']);
    expect(zeilenAusNamen(['Ein sehr langer Name ohne Ende'], 17, 60)[0]).toMatch(/…$/);
    expect(zeilenAusNamen([], 17, 100)).toEqual([]);
  });

  it('rastert den Kader zu einem PNG', async () => {
    const svg = renderRosterSvg({ teamName: 'Test', players: [{ number: 1, name: 'A' }], staff: [] });
    const png = await renderPng(svg);
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(png.readUInt32BE(16)).toBe(1600);
  });
});

describe('Endstand als Karte', () => {
  it('zeigt beide Logos, Stand, Halbzeit und Ausgang — keine Torschützen —, hebt die eigene Seite hervor und bricht lange Namen um', () => {
    const svg = renderResultSvg({
      competitionName: 'Kreisoberliga mB', subtitle: '3. Spieltag', dateLabel: 'Sa., 26.09.2026 · 16:00',
      homeName: 'TV Palmersheim II', awayName: 'HSG Siebengebirge-Thomasberg II', scoreHome: 22, scoreAway: 30,
      halftime: { home: 13, away: 12 }, ownIsHome: false, outcome: 'win', venue: 'Peter-Weber-Halle Kuchenheim',
      homeLogo: 'data:image/png;base64,HEIM', awayLogo: 'data:image/png;base64,GAST', opponentColor: '#e82838',
      playerOfMatch: 'Eskil Lieck · 12 Tore', streak: '3. Sieg in Folge', standing: 'Platz 1 · 6:0 Punkte',
      brand: { botHandle: '@WoelfeBot', stand: 'Sa., 26.09. 18:32' },
    });
    // Stand als zwei Zahlen um den türkisen Doppelpunkt, Kopfzeile, Halbzeit, Ausgang.
    expect(svg).toMatch(/text-anchor="end">22<\/text>/);
    expect(svg).toMatch(/text-anchor="start">30<\/text>/);
    expect(svg).toContain('HALBZEIT 13:12');
    expect(svg).toContain('>SIEG</text>');
    expect(svg).toContain('KREISOBERLIGA MB · 3. SPIELTAG · ENDSTAND');
    expect(svg).toContain('SA., 26.09.2026 · 16:00');
    // Beide Logos im Kreis, das Heim-Logo links; das eigene (Gast-)Logo zusätzlich als Wasserzeichen.
    expect(svg).toContain('<image href="data:image/png;base64,HEIM"');
    expect(svg).toContain('<image href="data:image/png;base64,GAST"');
    // Die Seiten stehen seit dem 28.09.2026 bei x = 135 / 665 (Logo-Rand 599), damit ein zweistelliger Stand nicht in die Kreise läuft.
    expect(svg.indexOf('HEIM"')).toBeLessThan(svg.indexOf('base64,GAST" x="599"'));
    expect(svg).toContain('base64,GAST" x="599"');
    expect(svg).not.toContain('>TORE</text>');
    // Der lange Gastname steht in zwei Zeilen, ohne Kürzung — die eigene Seite in Türkis.
    expect(svg).toContain('>HSG</text>');
    expect(svg).toMatch(/fill="#0bdbd6" text-anchor="middle" letter-spacing="1">SIEBENGEBIRGE-THOMASBERG II</);
    expect(svg).not.toContain('THOM…');
    // Der Gegner in seiner Farbe: Ring ums Logo und die schräge Fläche.
    expect(svg).toContain('stroke="#e82838"');
    expect(svg).toContain('fill="#e82838" opacity="0.18"');
    // Halle, Spieler des Spiels, Serie, Tabellenstand, Bot.
    expect(svg).toContain('Peter-Weber-Halle Kuchenheim');
    expect(svg).toContain('Spieler des Spiels: Eskil Lieck · 12 Tore');
    expect(svg).toContain('3. SIEG IN FOLGE');
    expect(svg).toContain('Stand: Sa., 26.09. 18:32 · Platz 1 · 6:0 Punkte');
    expect(svg).toContain('@WoelfeBot · Telegram-Bot');
    // Hallenmotiv und Glanz (nur bei Sieg).
    expect(svg).toContain('stroke-dasharray="14 10"');
    expect(svg).toContain('fill="url(#glow)"');
    expect(renderResultSvg({ competitionName: 'K', homeName: 'A', awayName: 'B', scoreHome: 20, scoreAway: 24, ownIsHome: true, outcome: 'loss' })).not.toContain('url(#glow)');
  });

  it('zeigt in einem Zwischenbild der Animation den Zwischenstand ohne Ausgang', () => {
    const basis = { competitionName: 'K', homeName: 'A', awayName: 'B', scoreHome: 30, scoreAway: 22, halftime: { home: 15, away: 11 }, ownIsHome: true, outcome: 'win' as const };
    const mitte = renderResultSvg({ ...basis, frame: { scoreHome: 12, scoreAway: 9, final: false } });
    expect(mitte).toMatch(/text-anchor="end">12<\/text>/);
    expect(mitte).not.toContain('>SIEG</text>');
    expect(mitte).not.toContain('HALBZEIT');
    expect(mitte).not.toContain('url(#glow)');
    const ende = renderResultSvg({ ...basis, frame: { scoreHome: 30, scoreAway: 22, final: true } });
    expect(ende).toContain('>SIEG</text>');
    expect(ende).toContain('HALBZEIT 15:11');
  });

  it('kommt ohne Halbzeit, Halle und Logos aus und rastert', async () => {
    const svg = renderResultSvg({ competitionName: 'K', homeName: 'A', awayName: 'B', scoreHome: 24, scoreAway: 27, ownIsHome: true, outcome: 'loss' });
    expect(svg).toContain('>NIEDERLAGE</text>');
    expect(svg).not.toContain('HALBZEIT');
    expect(svg).not.toContain('<image');
    // Ohne Logo stehen die Initialen im Kreis.
    expect(svg).toContain('>A</text>');
    const png = await renderPng(svg);
    expect(png.readUInt32BE(16)).toBe(1600);
    // Karten sind 16:9 — 1600 × 900.
    expect(png.readUInt32BE(20)).toBe(900);
    expect(renderResultSvg({ competitionName: 'K', homeName: 'A', awayName: 'B', scoreHome: 20, scoreAway: 20, ownIsHome: true, outcome: 'draw' })).toContain('UNENTSCHIEDEN');
  });
});

describe('Tendenz und nächster Gegner', () => {
  it('zeichnet Pfeile aus dem Stand davor und markiert den nächsten Gegner', () => {
    const svg = renderStandingsSvg({
      competitionName: 'K', ownTeamId: '1',
      rows: [zeile(1, '1', 'A', 6), zeile(2, '2', 'B', 4), zeile(3, '3', 'C', 2)],
      previousRows: [zeile(1, '2', 'B', 4), zeile(2, '1', 'A', 4), zeile(3, '3', 'C', 2)],
      nextOpponentId: '3',
    });
    expect(svg).toContain('>▲</text>');
    expect(svg).toContain('>▼</text>');
    expect(svg).toContain('fill="#fdf3e1"');
    expect(svg).toContain('nächster Gegner');
    // Ohne Vorstand und Gegner: keine Pfeile, keine Fußzeile.
    const ohne = renderStandingsSvg({ competitionName: 'K', ownTeamId: '1', rows: [zeile(1, '1', 'A', 6)] });
    expect(ohne).not.toContain('▲');
    expect(ohne).not.toContain('nächster Gegner');
    // Weniger Spiele als die Spitze: Sp grau und die Fußzeile sagt es.
    const ungleich = renderStandingsSvg({ competitionName: 'K', ownTeamId: '1', rows: [zeile(1, '1', 'A', 6), { ...zeile(2, '2', 'B', 4), played: 2 }] });
    expect(ungleich).toContain('Spieltag noch nicht komplett');
    expect(ungleich).toMatch(/fill="#5b6b73" text-anchor="end">2<\/text>/);
  });
});

describe('Nächstes Spiel als Karte', () => {
  it('zeigt VS, Datum, Anwurf und Halle mit beiden Logos und rastert', async () => {
    const svg = renderFixtureSvg({
      competitionName: 'Kreisoberliga mB', subtitle: '4. Spieltag', homeName: 'HSG Wölfe Voreifel', awayName: 'HV Erftstadt', ownIsHome: true,
      dateLabel: 'Sa., 03.10.2026', timeLabel: '14:45 Uhr', venue: 'Sporthalle Heimerzheim, Schulstrasse 1', homeLogo: 'data:image/png;base64,A', awayLogo: 'data:image/png;base64,B',
    });
    expect(svg).toContain('>VS</text>');
    expect(svg).toContain('KREISOBERLIGA MB · 4. SPIELTAG · NÄCHSTES SPIEL');
    expect(svg).toContain('>SA., 03.10.2026</text>');
    expect(svg).toContain('ANWURF 14:45 UHR');
    expect(svg).toContain('>HEIMSPIEL</text>');
    expect(svg).toContain('Sporthalle Heimerzheim');
    // Zwei Logos im Kreis plus das eigene als Wasserzeichen.
    expect((svg.match(/<image /g) ?? []).length).toBe(3);
    const png = await renderPng(svg);
    expect(png.readUInt32BE(16)).toBe(1600);
    expect(png.readUInt32BE(20)).toBe(900);
  });
});

describe('Diagramme', () => {
  it('zeichnet den Tabellenplatz-Verlauf mit einem Punkt je Spieltag und der Achse bis zum Saisonende', () => {
    const svg = renderPositionChartSvg({
      teamName: 'HSG Wölfe Voreifel', subtitle: 'Kreisoberliga mB · Tabellenplatz je Spieltag', totalRounds: 18,
      points: [{ round: 1, position: 5, points: 2, teams: 10 }, { round: 2, position: 2, points: 4, teams: 10 }, { round: 3, position: 1, points: 6, teams: 10 }],
    });
    expect(svg).toContain('Tabellenplatz je Spieltag');
    // Zehn Plätze auf der Achse, die Linie als Pfad, drei Punkte mit Platz darin.
    expect(svg).toContain('>10.<');
    // Drei Punkte mit Platz darin, der letzte mit Glanz; Kurve und Fläche als Pfade.
    expect((svg.match(/<circle [^>]*r="13"/g) ?? []).length).toBe(3);
    expect((svg.match(/<circle [^>]*r="24"/g) ?? []).length).toBe(1);
    expect((svg.match(/<path d="M[^"]* C/g) ?? []).length).toBe(3);
    expect(svg).toContain('fill="url(#flaeche)"');
    expect(svg).toContain('>6 Pkt<');
    expect(svg).toContain('Bestwert Platz 1 (3. Spieltag) · Tiefstwert Platz 5 (1. Spieltag)');
    // Achse bis zum 18. Spieltag, auch wenn erst drei gespielt sind.
    expect(svg).toContain('>17.<');
    // Der nächste Gegner am nächsten Spieltag, mit Logo oder Initialen.
    const mitGegner = renderPositionChartSvg({ teamName: 'X', points: [{ round: 1, position: 2, points: 2, teams: 4 }, { round: 2, position: 1, points: 4, teams: 4 }], nextOpponent: { name: 'HV Erftstadt', logo: null } });
    expect(mitGegner).toContain('nächster Gegner');
    expect(mitGegner).toContain('>HE</text>');
    // Ohne Punkte: kein Pfad, aber ein Hinweis.
    const leer = renderPositionChartSvg({ teamName: 'X', points: [] });
    expect(leer).not.toContain('<path d="M');
    expect(leer).toContain('Noch kein Spieltag gespielt');
  });

  it('zeichnet die Torjäger als Balken mit Siebenmeter-Anteil, höchstens zwölf', () => {
    const scorers = Array.from({ length: 15 }, (_, i) => ({ name: `Spieler ${i + 1}`, number: i + 1, goals: 30 - i, sevenMeterGoals: i === 0 ? 5 : 0, games: 3 }));
    const svg = renderScorersSvg({ teamName: 'HSG Wölfe Voreifel', subtitle: 'Torjäger', scorers, totalGoals: 200 });
    expect(svg).toContain('Spieler 1');
    expect(svg).toContain('Spieler 12');
    expect(svg).not.toContain('Spieler 13');
    expect(svg).toContain('15 % · 3 Sp.');
    expect(svg).toContain('davon Siebenmeter · 200 Tore insgesamt');
    // Die Namensspalte wächst mit dem längsten Namen: „Tillmann Imre Standfuß" stand am 28.09.2026 als „Tillmann Imre Sta…" da.
    const lang = renderScorersSvg({ teamName: 'X', scorers: [{ name: 'Tillmann Imre Standfuß', number: 24, goals: 12, sevenMeterGoals: 0, games: 3 }, { name: 'Eskil Lieck', number: 25, goals: 33, sevenMeterGoals: 5, games: 3 }], totalGoals: 106 });
    expect(lang).toContain('>Tillmann Imre Standfuß</text>');
    expect(lang).not.toContain('…');
    // Aber nicht grenzenlos: Ein absurd langer Name wird gekürzt, und der Balken behält seinen Platz.
    const absurd = renderScorersSvg({ teamName: 'X', scorers: [{ name: 'Maximilian-Alexander Freiherr von und zu Siebengebirge-Thomasberg', number: 1, goals: 5, sevenMeterGoals: 0, games: 1 }], totalGoals: 5 });
    expect(absurd).toMatch(/Maximilian-Alexander[^<]*…<\/text>/);
    // Ohne Tore: Hinweis statt Balken.
    expect(renderScorersSvg({ teamName: 'X', scorers: [{ name: 'A', number: 1, goals: 0, sevenMeterGoals: 0, games: 1 }], totalGoals: 0 })).toContain('Noch kein Tor gespeichert');
  });

  it('zeichnet die Tore je Spiel eines Spielers mit Schnittlinie', async () => {
    const svg = renderPlayerChartSvg({
      name: 'Eskil Lieck', number: 25, teamName: 'HSG Wölfe Voreifel', subtitle: 'Tore je Spiel',
      games: [{ opponent: 'HV Erftstadt', dateLabel: 'Sa, 06.09.', goals: 12, isHome: true }, { opponent: 'TV Palmersheim II', dateLabel: 'So, 14.09.', goals: 8, isHome: false }],
    });
    expect(svg).toContain('Eskil Lieck (Nr. 25)');
    expect(svg).toContain('gg. HV Erftstadt');
    expect(svg).toContain('bei TV Palmersheim II');
    expect(svg).toContain('Ø 10,0');
    expect(svg).toContain('stroke-dasharray');
    const png = await renderPng(svg);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});

describe('GIF und Vereinsfarbe', () => {
  it('baut aus mehreren Bildern ein GIF mit den Verzögerungen je Bild', async () => {
    const basis = { competitionName: 'K', homeName: 'A', awayName: 'B', scoreHome: 4, scoreAway: 2, ownIsHome: true, outcome: 'win' as const };
    const frames = [0, 2, 4].map(n => renderResultSvg({ ...basis, frame: { scoreHome: n, scoreAway: Math.floor(n / 2), final: n === 4 } }));
    const gif = await renderGif(frames, { delayMs: 90, holdLastMs: 3000 });
    expect(gif.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    const meta = await sharp(gif, { animated: true }).metadata();
    expect(meta.pages).toBe(3);
    expect(meta.delay).toEqual([90, 90, 3000]);
    expect(meta.width).toBe(800);
  });

  it('liest die Vereinsfarbe aus einem Logo und ignoriert Weiß und Schwarz', async () => {
    // Ein rotes Wappen auf Weiß mit schwarzem Rand.
    const rot = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#fff"/><rect x="4" y="4" width="56" height="56" fill="#000"/><rect x="10" y="10" width="44" height="44" fill="#e02030"/></svg>')).png().toBuffer();
    const farbe = await logoAccentColor(`data:image/png;base64,${rot.toString('base64')}`);
    expect(farbe).toMatch(/^#e[0-9a-f]2[0-9a-f]3[0-9a-f]$/);
    // Schwarz-weiß: keine Farbe.
    const sw = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#fff"/><circle cx="32" cy="32" r="20" fill="#000"/></svg>')).png().toBuffer();
    expect(await logoAccentColor(`data:image/png;base64,${sw.toString('base64')}`)).toBeNull();
    expect(await logoAccentColor(null)).toBeNull();
    expect(await logoAccentColor('data:image/png;base64,kaputt')).toBeNull();
  });
});

describe('Vereinsfarben aus der Konfiguration', () => {
  const rot = { primary: '#8B0000', secondary: '#a52a2a', accent: '#FFD700' };

  it('nimmt die Wölfe-Farben ohne Angabe und ersetzt nur gültige Felder', () => {
    expect(vervollstaendigePalette(null)).toEqual(DEFAULT_PALETTE);
    expect(vervollstaendigePalette({ primary: 'rot', accent: '#12345' })).toEqual(DEFAULT_PALETTE);
    const p = vervollstaendigePalette(rot);
    expect(p).toMatchObject({ primary: '#8b0000', secondary: '#a52a2a', accent: '#ffd700' });
    // Der Akzent für Text auf Weiß wird abgedunkelt, sobald er nicht der der Wölfe ist.
    expect(p.accentDark).not.toBe('#ffd700');
    expect(istHexFarbe('#0bdbd6')).toBe(true);
    expect(istHexFarbe('0bdbd6')).toBe(false);
    expect(themeFor(null).D.bg0).toBe('#001f2b');
  });

  it('jedes Bild enthält die Farben der Palette statt der Wölfe-Farben', () => {
    const tabelle = renderStandingsSvg({ competitionName: 'Liga', ownTeamId: 'a', rows: [zeile(1, 'a', 'A', 6), zeile(2, 'b', 'B', 2)], palette: rot });
    const karte = renderResultSvg({ competitionName: 'Liga', homeName: 'A', awayName: 'B', scoreHome: 30, scoreAway: 20, ownIsHome: true, outcome: 'win', palette: rot });
    const kader = renderRosterSvg({ teamName: 'A', players: [{ number: 7, name: 'X' }], staff: [], palette: rot });
    const spiel = renderFixtureSvg({ competitionName: 'Liga', homeName: 'A', awayName: 'B', ownIsHome: true, dateLabel: 'Sa.', timeLabel: '14:00 Uhr', palette: rot });
    const verlauf = renderPositionChartSvg({ teamName: 'A', points: [{ round: 1, position: 2, points: 2, teams: 4 }, { round: 2, position: 1, points: 4, teams: 4 }], palette: rot });
    const torjaeger = renderScorersSvg({ teamName: 'A', scorers: [{ name: 'X', number: 7, goals: 5, sevenMeterGoals: 1, games: 2 }], totalGoals: 5, palette: rot });
    const spieler = renderPlayerChartSvg({ name: 'X', number: 7, teamName: 'A', games: [{ opponent: 'B', dateLabel: 'Sa.', goals: 3, isHome: true }], palette: rot });
    for (const [art, svg] of Object.entries({ tabelle, karte, kader, spiel, verlauf, torjaeger, spieler })) {
      expect(svg, art).toContain('#8b0000');
      expect(svg, art).not.toContain('#003e51');
    }
    for (const svg of [tabelle, karte, kader, spiel, verlauf]) expect(svg).toContain('#ffd700');
    // Ohne Palette bleibt alles wie bisher.
    expect(renderStandingsSvg({ competitionName: 'Liga', ownTeamId: 'a', rows: [zeile(1, 'a', 'A', 6)] })).toContain('#003e51');
  });
});

describe('Saisonabschluss als Karte', () => {
  it('zeigt Endplatz, Bilanz, Tore, Punkte, Torschützenkönig, höchsten Sieg und den Verlauf', async () => {
    const svg = renderSeasonSummarySvg({
      teamName: 'HSG Wölfe Voreifel', competitionName: 'Kreisoberliga mB', subtitle: 'B-Jugend · Saison 2026/27',
      position: 1, teams: 10, won: 15, drawn: 1, lost: 2, goalsFor: 540, goalsAgainst: 410, points: 31,
      topScorer: 'Eskil Lieck · 87 Tore', biggestWin: '38:19 gegen HV Erftstadt',
      positions: [{ round: 1, position: 3 }, { round: 2, position: 2 }, { round: 3, position: 1 }],
      brand: { botHandle: '@WoelfeBot', stand: 'So., 26.04. 09:00' },
    });
    expect(svg).toContain('width="800" height="450"');
    expect(svg).toContain('KREISOBERLIGA MB · SAISONBILANZ');
    expect(svg).toContain('>1.</text>');
    expect(svg).toContain('von 10');
    expect(svg).toContain('MEISTER');
    expect(svg).toContain('15-1-2');
    expect(svg).toContain('540:410');
    expect(svg).toContain('31:5');
    expect(svg).toContain('Torschützenkönig: Eskil Lieck · 87 Tore');
    expect(svg).toContain('Höchster Sieg: 38:19 gegen HV Erftstadt');
    expect(svg).toContain('TABELLENPLATZ JE SPIELTAG');
    expect(svg).toContain('@WoelfeBot · Telegram-Bot');
    const png = await renderPng(svg);
    expect((await sharp(png).metadata()).width).toBe(1600);
  });

  it('kommt ohne Tabelle, Torschützen und Verlauf aus', () => {
    const svg = renderSeasonSummarySvg({ teamName: 'A', competitionName: 'Liga', position: null, teams: null, won: 2, drawn: 0, lost: 1, goalsFor: 70, goalsAgainst: 60, points: 4, palette: { accent: '#ff8800' } });
    expect(svg).toContain('SAISON');
    expect(svg).not.toContain('MEISTER');
    expect(svg).not.toContain('Torschützenkönig');
    expect(svg).not.toContain('TABELLENPLATZ');
    expect(svg).toContain('#ff8800');
  });
});
