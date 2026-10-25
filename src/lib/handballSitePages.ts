/**
 * Die Unterseiten der Microsite: die Seite eines einzelnen Spiels und die
 * Startseite mit allen Mannschaften. Aus `handballSite.ts` gelöst
 * (ARC-3-001) — dort bleiben Mannschaftsseite, Bilder, Feed und Kalender.
 */

import { vervollstaendigePalette } from './handballTableImage';
import { readPalette, vereinsName, logoDataUri, playerGames } from './handballTeam';
import { h, siteCssText, betreiberZeile, type SiteTeamLink, type SiteRenderOptions, routenLinks, statusWort, DATUM_LANG, ZEIT, spielverlaufSvg, heroHtml, teilenHtml, torfolgeText, STAND, TAG_ISO, standHeimGast, gegnerVon, VIBRATION_KNOPF, DATUM_KURZ, SITE_TITEL, punkteText, verpassenHtml, gruppenKaesten, spielWochenende, naechstesWochenende, letztesSpielWochenende, tagMonat, klappe, verschiebeTag, istLiveFenster, sprungleisteHtml } from './handballSite';
import { inhaltsHash, SITE_THEME_JS, SITE_APP_JS } from './handballSiteAssets';
import { type HandballTeamView, HANDBALL_GROUPS } from './handballSicht';
import { handballBotLink, getHandballBotUsername } from './handballBot';
import { clubName } from '../config';

// ---------------------------------------------------------------------------
// Unterseiten: Spielseite und Übersicht aller Mannschaften
// ---------------------------------------------------------------------------

/**
 * Das gemeinsame Gerüst der Unterseiten. Sie liegen eine Ebene tiefer als die
 * Mannschaftsseite (`/<Team-ID>/spiel/<Spiel>`) oder sind die Startseite; ihre
 * Dateien holen sie deshalb über `dateien` (Stil, Skript und Schrift liegen
 * unter der Mannschaft). Kein Manifest und kein eigener Service Worker — der
 * gehört der Mannschaftsseite.
 */
function unterseiteHtml(o: { dialog?: string; breit?: boolean; ogLogo?: boolean; app?: { titel: string; manifest: string }; live?: boolean; titel: string; beschreibung: string; url: string; ogBild: string | null; dateien: string; kopf: string; inhalt: string; fuss: string }): string {
  const palette = vervollstaendigePalette(readPalette());
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${h(o.titel)}</title>
<meta name="description" content="${h(o.beschreibung)}">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="${palette.primary}">
<meta name="color-scheme" content="light dark">
<meta property="og:type" content="website">
<meta property="og:title" content="${h(o.titel)}">
<meta property="og:description" content="${h(o.beschreibung)}">
<meta property="og:url" content="${h(o.url)}">
${o.ogBild ? (o.ogLogo
    ? `<meta property="og:image" content="${h(o.ogBild)}">\n<meta property="og:image:width" content="512">\n<meta property="og:image:height" content="512">\n<meta name="twitter:card" content="summary">`
    : `<meta property="og:image" content="${h(o.ogBild)}">\n<meta property="og:image:width" content="1600">\n<meta property="og:image:height" content="900">\n<meta name="twitter:card" content="summary_large_image">`) : ''}
<link rel="icon" href="${o.dateien}logo.png" type="image/png">
${o.app ? `<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-title" content="${h(o.app.titel)}">\n<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n<link rel="manifest" href="${h(o.app.manifest)}">\n<link rel="apple-touch-icon" href="${o.dateien}logo.png">` : ''}
<script src="${o.dateien}theme.js?v=${inhaltsHash(SITE_THEME_JS)}"></script>
<link rel="stylesheet" href="${o.dateien}site.css?v=${siteCssText().hash}">
</head>
<body${o.live ? ' data-live="1"' : ''}>
<a class="skip" href="#inhalt">Zum Inhalt</a>
<div class="offline" data-offline role="status" hidden>Du bist offline — gezeigt wird der zuletzt geladene Stand.</div>
${o.kopf}
<main class="wrap${o.breit ? ' breit' : ' schmal'}" id="inhalt">
${o.inhalt}
</main>
<footer class="wrap">
  ${o.fuss}
  ${betreiberZeile()}
</footer>
${o.dialog ?? ''}
<script src="${o.dateien}app.js?v=${inhaltsHash(SITE_APP_JS)}" defer></script>
</body>
</html>
`;
}

function initialenVon(name: string): string {
  return name.split(/\s+/).filter(w => /^[A-ZÄÖÜ]/.test(w)).map(w => w[0]).join('').slice(0, 3) || 'HB';
}

/** Die Mannschaftswahl für Unterseiten, die eine Ebene tiefer liegen als die Mannschaftsseite. */
function teamsEineEbeneTiefer(teams: SiteTeamLink[]): SiteTeamLink[] {
  return teams.map(t => ({ ...t, url: `../${t.url}` }));
}

/**
 * Die Spielseite: ein einzelnes Spiel mit allem, was die Seite dazu weiß —
 * Spielstand und Halbzeit, Endstandbild, Spielverlauf mit Torfolge, Halle samt
 * Route und die Torschützen. Der Spielbericht der Quelle steht
 * nicht auf der Seite, nur der Verweis auf den Bogen (PDF). Null, wenn die
 * Mannschaft dieses Spiel nicht hat.
 */
export function renderSpielHtml(team: HandballTeamView, matchId: string, opts: SiteRenderOptions): string | null {
  const m = team.matches.find(x => x.match_id === matchId);
  if (!m) return null;
  const now = opts.now ?? new Date();
  const start = new Date(m.starts_at);
  const fertig = (m.status === 'finished' || m.rated) && m.score_home !== null && m.score_away !== null;
  const halle = [m.venue_name, m.venue_address].filter(Boolean).join(', ');
  const routen = routenLinks(m);
  const wettbewerb = `${m.competition_name}${m.round ? `, ${m.round}. Spieltag` : ''}`;
  const status = statusWort(m);
  const ausgang = !fertig ? null : m.won === true ? 'Sieg' : m.won === false ? 'Niederlage' : 'Unentschieden';
  const hz = fertig && m.halftime_home !== null && m.halftime_away !== null ? `Halbzeit ${m.halftime_home}:${m.halftime_away}` : null;
  const paarung = `${m.home_name} gegen ${m.away_name}`;
  const stand = fertig ? `${m.score_home}:${m.score_away}` : null;
  const titel = `${stand ? `${m.home_name} ${stand} ${m.away_name}` : paarung} · ${vereinsName(team.name)}`;
  const beschreibung = `${DATUM_LANG.format(start)}, ${ZEIT.format(start)} Uhr · ${wettbewerb}${ausgang ? ` · ${ausgang}` : ''}`;
  const logo = logoDataUri(team.team_id);
  const verlauf = fertig ? spielverlaufSvg(m) : null;
  const schuetzen = fertig ? playerGames(team.team_id).filter(g => g.matchId === m.match_id && g.goals > 0) : [];
  const bild = fertig ? `../bild/endstand.png?match=${encodeURIComponent(m.match_id)}` : null;
  const kopf = heroHtml(team, logo, now, teamsEineEbeneTiefer(opts.teams ?? []), '', '../../');
  const inhalt = `<p><a class="zurueck" href="../">← Zur Mannschaftsseite</a></p>
<section class="card" id="spiel">
  <h2>${fertig ? 'Endstand' : m.is_live ? 'Läuft gerade' : 'Spiel'}${status && !fertig ? ` <span class="badge">${h(status)}</span>` : ''}</h2>
  <div class="spielstand" aria-label="${fertig ? 'Endstand' : 'Paarung'}">
    <span class="seite">${h(m.home_name)}</span>
    <b class="tore-gross">${stand ?? 'vs.'}</b>
    <span class="seite">${h(m.away_name)}</span>
  </div>
  <div class="info">
    <span>${h(DATUM_LANG.format(start))}, ${h(ZEIT.format(start))} Uhr · ${m.is_home ? 'Heimspiel' : 'Auswärts'}</span>
    <span class="muted small">${h(wettbewerb)}${ausgang ? ` · ${ausgang}${m.rated ? ' (gewertet)' : ''}` : ''}${hz ? ` · ${hz}` : ''}</span>
    ${halle ? `<span>📍 ${h(halle)}</span>` : ''}
  </div>
  ${bild ? `<img class="bild" style="margin-top:14px" src="${h(bild)}" width="800" height="450" alt="${h(`Endstand ${m.home_name} ${m.score_home}:${m.score_away} ${m.away_name}`)}" loading="lazy">` : ''}
  <div class="row" style="margin-top:14px">
    ${teilenHtml({ url: `${opts.baseUrl}spiel/${encodeURIComponent(m.match_id)}`, titel, text: stand ? `Endstand: ${m.home_name} ${stand} ${m.away_name}` : `${paarung} · ${DATUM_LANG.format(start)}, ${ZEIT.format(start)} Uhr`, bild })}
    ${routen.map(r => `<a class="btn" href="${h(r.href)}" target="_blank" rel="noopener noreferrer">🧭 ${h(r.label)}</a>`).join('')}
    ${m.report_url ? `<a class="btn" href="${h(m.report_url)}" target="_blank" rel="noopener noreferrer">Spielberichtsbogen (PDF)</a>` : ''}
    <a class="btn" href="${h(m.url)}" target="_blank" rel="noopener noreferrer">Auf handball.net</a>
  </div>
</section>
${verlauf ? `<section class="card" id="verlauf">
  <h2>Spielverlauf</h2>
  <div class="verlauf">${verlauf}</div>${torfolgeText(m)}
</section>` : ''}
${schuetzen.length > 0 ? `<section class="card" id="schuetzen">
  <h2>Torschützen</h2>
  <ul class="schuetzen">${schuetzen.map(g => `<li><span>${h(g.name)}</span><b>${g.goals} Tor${g.goals === 1 ? '' : 'e'}${g.sevenMeterGoals > 0 ? ` <span class="muted small">(${g.sevenMeterGoals}× 7m)</span>` : ''}</b></li>`).join('')}</ul>
</section>` : ''}`;
  const fuss = `<div>Daten von <a href="https://www.handball.net/team/${encodeURIComponent(team.team_id)}" target="_blank" rel="noopener noreferrer">handball.net</a>${opts.stand ? ` · Stand ${h(STAND.format(new Date(opts.stand)))} Uhr` : ''}. Spielzeiten in deutscher Ortszeit.</div>`;
  return unterseiteHtml({
    titel, beschreibung, url: `${opts.baseUrl}spiel/${encodeURIComponent(m.match_id)}`,
    ogBild: bild ? `${opts.baseUrl}bild/endstand.png?match=${encodeURIComponent(m.match_id)}` : null,
    dateien: '../', kopf, inhalt, fuss,
  });
}

/** Die Reihenfolge „Herren, Damen, Jugend" für die Sortierung der Heimspiele; Weitere zuletzt. */
const GRUPPEN_RANG: Record<string, number> = { herren: 0, frauen: 1, jungen: 2, maedchen: 3, kinder: 4 };
const GRUPPEN_KURZ: Record<string, string> = { herren: 'Herren', frauen: 'Damen', jungen: 'Jugend m', maedchen: 'Jugend w', kinder: 'Kinder' };

/**
 * Die Startseite (`/`), „Wölfe live - Handball im Revier": der Überblick über alle
 * Mannschaften des Vereins. Oben die fünf Bereiche mit ihren Mannschaften zum
 * Aufklappen; dann, was läuft; dann die Heimspiele des Wochenendes (Fr–So) in
 * einer Tabelle, die sich per Chip nach Datum, Spielort oder Bereich sortieren
 * lässt — mit Halle, Adresse und Routenlink, damit man sieht, wo gespielt
 * wird; darunter jede Mannschaft mit Tabellenplatz, nächstem und letztem
 * Spiel. Liest nur, was die Übersicht schon hat.
 */
export function renderStartHtml(teams: HandballTeamView[], opts: { teams: SiteTeamLink[]; baseUrl: string; stand: string | null; now?: Date; pushEnabled?: boolean }): string {
  const now = opts.now ?? new Date();
  const erste = teams[0];
  const link = (t: HandballTeamView, anker = '') => `./${encodeURIComponent(t.team_id)}/${anker}`;
  const alle = teams.flatMap(t => t.matches.map(m => ({ t, m })));
  const live = alle.filter(x => x.m.is_live);

  const kommendes = naechstesWochenende(now);
  const we = spielWochenende(alle.map(x => x.m), now);
  const tage = [we.fr, we.sa, we.so];
  const heute = TAG_ISO.format(now);
  const laeuft = tage.includes(heute);
  const spaeter = we.fr !== kommendes.fr;
  const heimspiele = alle
    .filter(x => x.m.is_home && x.m.status !== 'cancelled' && x.m.status !== 'postponed'
      && tage.includes(TAG_ISO.format(new Date(x.m.starts_at))))
    .sort((a, b) => a.m.starts_at.localeCompare(b.m.starts_at));

  const liveHtml = live.length > 0 ? `<section class="card dark live" id="live">
  <h2>Läuft gerade <span class="badge live">Live</span></h2>
  <ul class="plan">${live.map(({ t, m }) => {
    const stand = m.live && m.live.home !== null && m.live.away !== null ? `${m.live.home}:${m.live.away}` : standHeimGast(m) ?? '–:–';
    return `<li>
      <span class="d">${h(ZEIT.format(new Date(m.starts_at)))} Uhr</span>
      <span class="g"><a class="titel" href="${h(link(t, '#naechstes'))}">${h(t.label)}</a><div class="ha">${m.is_home ? 'gegen' : 'bei'} ${h(gegnerVon(m))}${m.venue_name ? ` · ${h(m.venue_name)}` : ''}</div><button type="button" class="stumm" data-stumm="${h(t.team_id)}" aria-pressed="false" hidden>🔔 Tore melden</button></span>
      <span class="e" data-key="${h(t.team_id)}" data-label="${h(t.label)}" data-heim="${m.is_home ? '1' : '0'}" data-stand="${/^\d+:\d+$/.test(stand) ? stand : ''}">${stand}</span>
    </li>`;
  }).join('')}</ul>
  <div class="row livesteuerung" style="margin-top:12px">${VIBRATION_KNOPF}<span class="muted small" data-stumm-hinweis hidden>Mit „Tore melden“ wählst du, bei welchen Spielen dieses Gerät Tore anzeigt und vibriert.</span></div>
</section>` : '';

  // Ohne laufendes Spiel steht hier, wann es wieder losgeht — sonst sieht man von der Live-Ansicht nichts.
  const naechsteAnwuerfe = alle
    .filter(x => x.m.status === 'scheduled' && Date.parse(x.m.starts_at) > now.getTime())
    .sort((a, b) => a.m.starts_at.localeCompare(b.m.starts_at));
  const naechster = naechsteAnwuerfe[0];
  const liveLeerHtml = live.length === 0 ? `<section class="card live-leer" id="live">
  <h2>Live <span class="badge">Gerade kein Spiel</span></h2>
  <p class="livehinweis"><span class="punkt" aria-hidden="true"></span><span>${naechster
    ? `<b>Nächster Anwurf:</b> ${h(DATUM_KURZ.format(new Date(naechster.m.starts_at)))}, ${h(ZEIT.format(new Date(naechster.m.starts_at)))} Uhr, ${h(naechster.t.label)} ${naechster.m.is_home ? 'gegen' : 'bei'} ${h(gegnerVon(naechster.m))}. `
    : 'Zurzeit ist kein Spiel angesetzt. '}Sobald ein Spiel läuft, steht der Spielstand hier ganz oben. Die Seite aktualisiert sich dann alle 30 Sekunden und meldet Tore mit Vibration.</span></p>
</section>` : '';

  const beschreibung = heimspiele.length > 0
    ? `${heimspiele.length} Heimspiel${heimspiele.length === 1 ? '' : 'e'} am Wochenende ${tagMonat(we.fr)}–${tagMonat(we.so)} — Überblick über alle Mannschaften`
    : 'Überblick über alle Mannschaften: Heimspiele, Spielorte und Ergebnisse';
  const auswaertsspiele = alle
    .filter(x => !x.m.is_home && x.m.status !== 'cancelled' && x.m.status !== 'postponed'
      && tage.includes(TAG_ISO.format(new Date(x.m.starts_at))))
    .sort((a, b) => a.m.starts_at.localeCompare(b.m.starts_at));

  /** Eine Wochenend-Tabelle: Heim- oder Auswärtsspiele, sortierbar nach Datum, Spielort und Bereich. */
  const wochenendTabelle = (id: string, ueberschrift: string, zusatz: string, spiele: typeof heimspiele, leer: string) => {
    const zeilen = spiele.map(({ t, m }) => {
      const start = new Date(m.starts_at);
      const fertig = (m.status === 'finished' || m.rated) && m.score_home !== null && m.score_away !== null;
      const name = m.venue_name?.trim() || '';
      const adresse = m.venue_address?.trim() || '';
      const routen = routenLinks(m);
      const rang = t.group ? GRUPPEN_RANG[t.group] : 9;
      const ergebnis = m.is_live ? ' <span class="badge live">Live</span>'
        : fertig ? ` <b class="erg ${m.won === true ? 'w' : m.won === false ? 'l' : ''}">${standHeimGast(m)}</b>` : '';
      return `<tr data-ts="${h(m.starts_at)}" data-ort="${h(name.toLowerCase())}" data-gr="${rang}">
      <td class="wann" data-label="Datum">${h(DATUM_KURZ.format(start))}<small>${h(ZEIT.format(start))} Uhr</small></td>
      <td class="team" data-label="Mannschaft"><a href="${h(link(t, '#naechstes'))}">${h(t.label)}</a>${t.group ? `<small>${h(GRUPPEN_KURZ[t.group])}</small>` : ''}</td>
      <td class="geg" data-label="Gegner">${h(gegnerVon(m))}${ergebnis}<small>${h(m.competition_name)}</small></td>
      <td class="ort" data-label="Spielort">${name || adresse ? `<b>📍 ${name ? h(name) : h(adresse)}</b>${name && adresse ? `<small>${h(adresse)}</small>` : ''}${routen.length > 0 ? `<a href="${h(routen[0].href)}" target="_blank" rel="noopener noreferrer">🧭 Route</a>` : ''}` : '<span class="muted">Halle noch nicht bekannt</span>'}</td>
    </tr>`;
    });
    const sortierung = [['datum', 'Datum'], ['ort', 'Spielort'], ['gruppe', 'Herren · Damen · Jugend']] as const;
    const k = id === 'auswaertsspiele'
      ? klappe('auswaerts', spiele.length > 0 ? `${spiele.length} Auswärtsspiel${spiele.length === 1 ? '' : 'e'} von Freitag bis Sonntag` : 'Kein Auswärtsspiel von Freitag bis Sonntag')
      : { attr: '', zeile: '' };
    return `<section class="card" id="${id}"${k.attr}>
  <h2>${ueberschrift} <span class="muted small">${zusatz} · ${tagMonat(we.fr)}–${tagMonat(we.so)}</span>${id === 'heimspiele' ? teilenHtml({ url: opts.baseUrl, titel: SITE_TITEL, text: beschreibung, bild: './bild/wochenende.png' }).replace('class="btn teilen"', 'class="btn teilen klein"') : ''}</h2>
  ${k.zeile}
  ${spiele.length > 0 ? `<div class="sortieren" data-sortbar hidden role="group" aria-label="${ueberschrift} sortieren">
    <span class="muted small">Sortieren nach</span>
    ${sortierung.map(([k, t], i) => `<button type="button" data-sort="${k}" aria-pressed="${i === 0 ? 'true' : 'false'}">${t}</button>`).join('')}
  </div>
  <div class="tabelle-rahmen"><table class="heim" data-sorttable>
    <thead><tr><th scope="col">Datum</th><th scope="col">Mannschaft</th><th scope="col">Gegner</th><th scope="col">Spielort</th></tr></thead>
    <tbody>${zeilen.join('')}</tbody>
  </table></div>`
    : `<p class="muted">${leer}</p>`}
</section>`;
  };
  // Heute: alle Spiele des Tages, Heim und Auswärts — was gerade läuft steht schon im Live-Kasten.
  const heuteSpiele = alle
    .filter(x => !x.m.is_live && x.m.status !== 'cancelled' && x.m.status !== 'postponed' && TAG_ISO.format(new Date(x.m.starts_at)) === heute)
    .sort((a, b) => a.m.starts_at.localeCompare(b.m.starts_at));
  const heuteHtml = heuteSpiele.length > 0 ? `<section class="card dark" id="heute">
  <h2>Heute <span class="muted small">${h(DATUM_KURZ.format(now))}</span></h2>
  <ul class="plan">${heuteSpiele.map(({ t, m }) => {
    const fertig = (m.status === 'finished' || m.rated) && m.score_home !== null && m.score_away !== null;
    const stand = fertig ? `<span class="e ${m.won === true ? 'w' : m.won === false ? 'l' : ''}">${standHeimGast(m)}</span>` : `<span class="e">${m.is_home ? 'Heim' : 'Auswärts'}</span>`;
    const ort = m.venue_name?.trim() ? ` · ${h(m.venue_name.trim())}` : '';
    return `<li>
      <span class="d">${h(ZEIT.format(new Date(m.starts_at)))} Uhr</span>
      <span class="g"><a class="titel" href="${h(link(t, fertig ? `spiel/${encodeURIComponent(m.match_id)}` : '#naechstes'))}">${h(t.label)}</a><div class="ha">${m.is_home ? 'gegen' : 'bei'} ${h(gegnerVon(m))}${ort}</div></span>
      ${stand}
    </li>`;
  }).join('')}</ul>
</section>` : '';

  // Letztes Wochenende: die Ergebnisse aller Mannschaften, damit man nachlesen kann, wie es war.
  const lw = letztesSpielWochenende(alle.map(x => x.m), kommendes);
  const letzteTage = [lw.fr, lw.sa, lw.so];
  const letzte = alle
    .filter(x => (x.m.status === 'finished' || x.m.rated) && x.m.score_home !== null && x.m.score_away !== null
      && letzteTage.includes(TAG_ISO.format(new Date(x.m.starts_at))))
    .sort((a, b) => a.m.starts_at.localeCompare(b.m.starts_at));
  const siege = letzte.filter(x => x.m.won === true).length;
  const niederlagen = letzte.filter(x => x.m.won === false).length;
  const remis = letzte.length - siege - niederlagen;
  const bilanz = [siege ? `${siege} Sieg${siege === 1 ? '' : 'e'}` : '', remis ? `${remis} Unentschieden` : '', niederlagen ? `${niederlagen} Niederlage${niederlagen === 1 ? '' : 'n'}` : ''].filter(Boolean).join(' · ');
  const kLetzte = klappe('ergebnisse', `${letzte.length} Spiel${letzte.length === 1 ? '' : 'e'}: ${bilanz}`);
  const letzteHtml = letzte.length > 0 ? `<section class="card" id="letztes-wochenende"${kLetzte.attr}>
  <h2>Ergebnisse <span class="muted small">${lw.fr === verschiebeTag(kommendes.fr, -7) ? 'letztes Wochenende' : 'letzter Spieltag'} · ${tagMonat(letzteTage[0]!)}–${tagMonat(letzteTage[2]!)}</span></h2>
  ${kLetzte.zeile}
  <p class="muted small bilanz">${h(bilanz)}</p>
  <ul class="plan">${letzte.map(({ t, m }) => `<li>
      <span class="d">${h(DATUM_KURZ.format(new Date(m.starts_at)))}</span>
      <span class="g"><a class="titel" href="${h(link(t, `spiel/${encodeURIComponent(m.match_id)}`))}">${h(t.label)}</a><div class="ha">${m.is_home ? 'gegen' : 'bei'} ${h(gegnerVon(m))}</div></span>
      <span class="e ${m.won === true ? 'w' : m.won === false ? 'l' : ''}">${standHeimGast(m)}</span>
    </li>`).join('')}</ul>
</section>` : '';

  const wann = laeuft ? 'dieses Wochenende' : spaeter ? 'nächster Spieltag' : 'nächstes Wochenende';
  const weHtml = wochenendTabelle('heimspiele', 'Heimspiele', wann, heimspiele, `Von Freitag bis Sonntag (${tagMonat(we.fr)}–${tagMonat(we.so)}) ist kein Heimspiel angesetzt.`);
  const ausHtml = wochenendTabelle('auswaertsspiele', 'Auswärtsspiele', wann, auswaertsspiele, `Von Freitag bis Sonntag (${tagMonat(we.fr)}–${tagMonat(we.so)}) ist kein Auswärtsspiel angesetzt.`);

  // Der Stand: je Mannschaft Platz, Punkte und das letzte Ergebnis — eine Zeile, kein Spielplan; nach Bereich gruppiert wie die Kästen im Kopf.
  const standZeile = (t: HandballTeamView) => {
    const tabelle = t.standings.find(s => s.rows.some(r => r.teamId === t.team_id));
    const zeile = tabelle?.rows.find(r => r.teamId === t.team_id);
    const l = t.last_match;
    const zuletzt = l && l.score_home !== null && l.score_away !== null
      ? `<span class="erg ${l.won === true ? 'w' : l.won === false ? 'l' : ''}">${standHeimGast(l)}</span> ${l.is_home ? 'gegen' : 'bei'} ${h(gegnerVon(l))}` : '<span class="muted">noch kein Spiel</span>';
    return `<tr>
      <td class="team" data-label="Mannschaft"><a href="${h(link(t))}">${h(t.label)}</a>${tabelle ? `<small>${h(tabelle.competition_name)}</small>` : ''}</td>
      <td data-label="Platz">${zeile ? `<b>${zeile.position}.</b><small>von ${tabelle!.rows.length}</small>` : '<span class="muted">–</span>'}</td>
      <td data-label="Punkte">${zeile ? `<b>${punkteText(zeile)}</b><small>${zeile.played} Sp.</small>` : '<span class="muted">–</span>'}</td>
      <td data-label="Zuletzt">${zuletzt}</td>
    </tr>`;
  };
  const kStand = klappe('stand', teams.length === 1 ? 'Platz, Punkte und letztes Ergebnis der Mannschaft' : `Platz, Punkte und letztes Ergebnis aller ${teams.length} Mannschaften`);
  const standHtml = `<section class="card" id="stand"${kStand.attr}>
  <h2>Tabellenplätze</h2>
  ${kStand.zeile}
  <div class="tabelle-rahmen"><table class="heim stand">
    <thead><tr><th scope="col">Mannschaft</th><th scope="col">Platz</th><th scope="col">Punkte</th><th scope="col">Zuletzt</th></tr></thead>
    ${[...HANDBALL_GROUPS.map(g => ({ label: g.label, teams: teams.filter(t => t.group === g.id) })), { label: 'Weitere', teams: teams.filter(t => t.group === null) }]
      .filter(g => g.teams.length > 0)
      .map(g => `<tbody><tr class="bereich"><th scope="rowgroup" colspan="4">${h(g.label)}</th></tr>${g.teams.map(standZeile).join('')}</tbody>`).join('')}
  </table></div>
</section>`;

  const titel = SITE_TITEL;
  const logo = logoDataUri(erste.team_id);
  const botLink = handballBotLink();
  const botName = getHandballBotUsername();
  const verpassen = verpassenHtml(opts.baseUrl, opts.pushEnabled === true, botLink && botName ? { link: botLink, handle: `@${botName}` } : null, true);
  const kopf = `<header class="hero start"><div class="wrap">
  <button type="button" class="theme" data-theme-toggle hidden aria-label="Farbschema: automatisch" title="Farbschema: automatisch">◐</button>
  ${verpassen.leiste}
  <a class="heim" href="./" aria-label="Zur Startseite">${logo ? `<img class="logo" src="${logo}" alt="">` : `<div class="initialen" aria-hidden="true">${h(initialenVon(erste.name))}</div>`}</a>
  <div class="verein"><a class="heim titel" href="./"><span class="kicker">${h(clubName())}</span></a></div>
  ${gruppenKaesten(teams.map(t => ({ id: t.team_id, label: t.label, group: t.group, url: link(t) })), null, '', true)}
  <div class="teaminfo">
    <h1>${h(titel)}</h1>
    <div class="sub">Heimspiele, Spielorte und Ergebnisse aller Mannschaften</div>
  </div>
</div></header>`;
  const fuss = `<div>Daten von <a href="https://www.handball.net" target="_blank" rel="noopener noreferrer">handball.net</a>${opts.stand ? ` · Stand ${h(STAND.format(new Date(opts.stand)))} Uhr` : ''}. Spielzeiten in deutscher Ortszeit.</div>`;
  return unterseiteHtml({
    titel, beschreibung, url: opts.baseUrl, ogBild: `${opts.baseUrl}${encodeURIComponent(erste.team_id)}/logo.png`, ogLogo: true,
    dateien: `./${encodeURIComponent(erste.team_id)}/`,
    kopf: kopf + sprungleisteHtml([
      ['live', liveHtml ? 'Läuft gerade' : 'Live', liveHtml || liveLeerHtml],
      ['heute', 'Heute', heuteHtml],
      ['heimspiele', 'Heimspiele', weHtml],
      ['auswaertsspiele', 'Auswärtsspiele', ausHtml],
      ['letztes-wochenende', 'Ergebnisse', letzteHtml],
      ['stand', 'Tabellenplätze', standHtml],
    ]), inhalt: `${liveHtml || liveLeerHtml}\n${heuteHtml}\n${weHtml}\n${ausHtml}\n${letzteHtml}\n${standHtml}`, fuss, breit: true, dialog: verpassen.dialog,
    app: { titel: 'Wölfe live', manifest: './manifest.webmanifest' }, live: live.length > 0 || teams.some(t => istLiveFenster(t.next_match, now)),
  });
}
