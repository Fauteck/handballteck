import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'fs';

/**
 * Die Vereinsseite bei ClubDesk: Übersicht und Teamseite lesen. Die Vorlagen
 * hier sind nachgebaut (Aufbau wie am 01.10.2026), nicht kopiert — keine
 * echten Namen im Repo.
 */

process.env.DATABASE_PATH = `/tmp/handball-clubdesk-${process.pid}.db`;

let cd: typeof import('../lib/clubdesk');

beforeAll(async () => {
  cd = await import('../lib/clubdesk');
});

afterAll(() => {
  for (const f of ['', '-wal', '-shm']) { try { unlinkSync(`${process.env.DATABASE_PATH}${f}`); } catch { /* nicht da */ } }
});

const UEBERSICHT = `
<base href="/clubdesk/"/>
<div class="cd-image-block">
<a href="https://verein.clubdesk.com/spielbetrieb/teams-und-tabellen/woelfe_1"><img class="cd-image-contain"src="fileservlet?type=image&amp;id=1000871&amp;s=djEtAbc_123-x=" alt="" /><div class="cd-image-caption-container"><p class="cd-image-caption">W&ouml;lfe I</p></div></a></div>
<div class="cd-image-block">
<a href="https://verein.clubdesk.com/spielbetrieb/teams-und-tabellen/woelfe_b"><img class="cd-image-contain"src="fileservlet?type=image&amp;id=1000902&amp;s=djEtDef_456-y=" alt="" /><div class="cd-image-caption-container"><p class="cd-image-caption">B-Jugend (2010/2011)</p></div></a></div>
<a href="https://verein.clubdesk.com/spielbetrieb/teams-und-tabellen/fremd"><img src="https://anderswo.example/bild.png" alt="" /></a>
<img alt="Sponsor" class="cd-image-cover" src="fileservlet?type=image&amp;id=1000092&amp;s=djEtSponsor="/>
`;

const kachel = (contact: string, name: string, bild: string | null, position: string | null) => `
    <div tabindex="0" class="cd-tile-v-box cd-tile-width-4"  >
        <span class="cd-back-anchor" id="contactlistblock-null-contact-${contact}"></span>
        ${bild ? `<div class="cd-image-wrapper-1"><div class="cd-image-content "><img class="cd-zoom cd-image-cover"
                     src="fileservlet?type=image&amp;id=${bild}&amp;s=djEtSig${bild}=&amp;imageFormat=_1024x1024"
                     alt="Kontaktfoto"/></div></div>` : ''}
        <div class="cd-tile-v-main-area" >
            <div class="cd-tile-v-main-heading">${name}</div>
            <div class="cd-tile-v-main-subheading"></div>
        </div>
        <div class="cd-tile-v-detail-area"><ul>
            ${position ? `<li><div class="cd-tile-v-detail-label">Position</div>
                    <div class="cd-tile-v-detail-value">${position}</div></li>` : ''}
        </ul></div>
    </div>`;

const TEAMSEITE = `
<h2>Wölfe I</h2>
<h3>Trainer(in)</h3>
<div class="cd-tile-container">${kachel('2001', 'Trainer Eins', '3001', 'Trainer')}</div>
<h3>Spieler(in)</h3>
<div class="cd-tile-container">${kachel('2002', 'Spieler M&uuml;ller', '3002', 'Rückraum links')}${kachel('2003', 'Ohne Foto', null, null)}</div>
<h3>Torwart</h3>
<div class="cd-tile-container">${kachel('2004', 'Torwart Eins', '3004', 'Torwart')}</div>
<h3>Die nächsten Spiele</h3>
<div>Widget</div>
`;

describe('ClubDesk lesen', () => {
  it('ordnet in der Übersicht je Teamseite Gruppenbild und Bildunterschrift zu — nur Bilder von ClubDesk', () => {
    expect(cd.parseUebersicht(UEBERSICHT)).toEqual([
      { slug: 'woelfe_1', caption: 'Wölfe I', imageId: '1000871', signature: 'djEtAbc_123-x=' },
      { slug: 'woelfe_b', caption: 'B-Jugend (2010/2011)', imageId: '1000902', signature: 'djEtDef_456-y=' },
    ]);
  });

  it('liest die Kacheln der Teamseite samt Abschnitt und Position — auch ohne Foto', () => {
    const leute = cd.parseTeamseite(TEAMSEITE);
    expect(leute.map(p => [p.contactId, p.name, p.section, p.position, p.imageId])).toEqual([
      ['2001', 'Trainer Eins', 'Trainer(in)', 'Trainer', '3001'],
      ['2002', 'Spieler Müller', 'Spieler(in)', 'Rückraum links', '3002'],
      ['2003', 'Ohne Foto', 'Spieler(in)', null, null],
      ['2004', 'Torwart Eins', 'Torwart', 'Torwart', '3004'],
    ]);
    expect(leute[1].signature).toBe('djEtSig3002=');
  });

  it('erkennt Jugendmannschaften am Namen oder an der Bildunterschrift', () => {
    expect(cd.istJugend('mB-Jugend')).toBe(true);
    expect(cd.istJugend('2. Herren', 'A-Jugend (2008/2009)')).toBe(true);
    expect(cd.istJugend('2. Herren', 'Wölfe U23')).toBe(false);
  });

  it('holt ohne Konfiguration nichts', async () => {
    delete process.env.CLUBDESK_URL; delete process.env.CLUBDESK_TEAMS;
    expect((await cd.clubdeskHolen(new Map())).status).toBe('aus');
    process.env.CLUBDESK_URL = 'http://unsicher.example';
    process.env.CLUBDESK_TEAMS = '75796=woelfe_2';
    // Nur https und nur die Wurzel — sonst gilt die Adresse als nicht gesetzt.
    expect((await cd.clubdeskHolen(new Map())).status).toBe('aus');
    delete process.env.CLUBDESK_URL; delete process.env.CLUBDESK_TEAMS;
  });
});
