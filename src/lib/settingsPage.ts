/**
 * Die Seite `/settings`: eine feste HTML-Hülle und ein Skript, das alles
 * Weitere über die JSON-Aufrufe unter `/settings/api/*` holt. Das Skript ist
 * eine eigene Route (kein Inline-JavaScript, CSP); Texte der Daten kommen nur
 * über `textContent` in die Seite, nie als HTML.
 */

export function settingsHtml(): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Einstellungen · Handballteck</title>
<style>
:root{--bg:#f5f7f8;--card:#fff;--text:#14232b;--muted:#5d6e77;--line:#d5dde1;--accent:#003e51;--on-accent:#fff;--warn:#9a4b00;--err:#b00020;--ok:#1b6e3a}
@media (prefers-color-scheme:dark){:root{--bg:#10181c;--card:#18242a;--text:#e6eef1;--muted:#97a8b0;--line:#2c3c44;--accent:#2fb7b2;--on-accent:#06161a;--warn:#f0a95a;--err:#ff8a9b;--ok:#6ccf93}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:16px}
h1{font-size:1.4rem;margin:0 0 4px}
h2{font-size:1.1rem;margin:0 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
nav{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}
button,.btn{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:8px;padding:8px 14px;cursor:pointer;min-height:40px}
button.primary{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
button.active,[role=tab][aria-selected=true]{border-color:var(--accent);box-shadow:inset 0 -3px 0 var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
[role=tab] .zahl{display:inline-block;margin-left:6px;min-width:20px;padding:0 6px;border-radius:99px;background:var(--accent);color:var(--on-accent);font-size:.75rem;line-height:20px}
button:disabled{opacity:.5;cursor:default}
label{display:block;font-weight:600;margin-bottom:4px}
input,select,textarea{font:inherit;width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
.zeile>input[type=color]{flex:0 0 56px;width:56px;padding:2px;height:40px}
textarea{min-height:84px;resize:vertical}
.feld{padding:12px 0;border-top:1px solid var(--line)}
.feld:first-of-type{border-top:0}
.hint{color:var(--muted);font-size:.875rem;margin:4px 0 0}
.zeile{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.zeile>input,.zeile>select,.zeile>textarea{flex:1 1 220px}
.badge{display:inline-block;font-size:.75rem;padding:1px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted);margin-left:6px;font-weight:400}
.badge.seite{color:var(--accent);border-color:var(--accent)}
.err{color:var(--err);font-size:.875rem;margin-top:4px}
.ok{color:var(--ok)}.warn{color:var(--warn)}
.fehlerfeld input,.fehlerfeld textarea,.fehlerfeld select{border-color:var(--err)}
table{border-collapse:collapse;width:100%;font-size:.875rem}
td,th{text-align:left;padding:4px 8px;border-top:1px solid var(--line);vertical-align:top;word-break:break-word}
.meldung{padding:10px 14px;border-radius:8px;border:1px solid var(--line);margin:12px 0}
.hidden{display:none}
.vorschau{display:inline-flex;gap:0;border-radius:8px;overflow:hidden;border:1px solid var(--line);height:28px;vertical-align:middle}
.vorschau span{width:36px;display:block}
.mrow{display:grid;grid-template-columns:18px 140px 84px minmax(0,1fr) minmax(0,1fr) 132px 128px;gap:8px;align-items:center;margin-bottom:8px}
.mrow .griff{cursor:grab;color:var(--muted);user-select:none;text-align:center}
.mrow.ziel{outline:2px dashed var(--accent);outline-offset:2px;border-radius:8px}
.mrow .minfo{grid-column:2/-1;font-size:.8rem;color:var(--muted);margin-top:-4px;display:flex;gap:12px;flex-wrap:wrap}
.mrow .minfo a{color:var(--accent)}
h4.bereich{margin:14px 0 6px;font-size:.85rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border-bottom:1px solid var(--line);padding-bottom:4px}
.mrow.kopf{font-size:.8rem;font-weight:600;color:var(--muted);margin-bottom:4px}
.mrow .fotos{display:flex;flex-direction:column;gap:2px;font-size:.85rem;font-weight:400;white-space:nowrap}
.mrow .fotos label{display:flex;align-items:center;gap:6px;margin:0;font-weight:400;min-height:20px}
.mrow .fotos input{width:auto;margin:0}
.mrow .knoepfe{display:flex;gap:4px}
.mrow .knoepfe button{padding:4px 10px;min-height:40px}
@media (max-width:720px){.mrow{grid-template-columns:1fr 1fr}.mrow .griff{display:none}.mrow select,.mrow .fotos,.mrow .knoepfe,.mrow .minfo{grid-column:1/-1}.mrow.kopf{display:none}.mrow{padding-bottom:10px;border-bottom:1px solid var(--line)}}
.schalter{appearance:none;-webkit-appearance:none;width:48px;height:28px;padding:0;border-radius:99px;background:var(--line);position:relative;cursor:pointer;flex:0 0 48px;margin:0}
.schalter::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:var(--card);transition:left .15s}
.schalter:checked{background:var(--accent)}
.schalter:checked::after{left:25px}
.schalter:disabled{opacity:.5}
details.mehr{font-size:.875rem;color:var(--muted);margin-top:2px}
details.mehr summary{cursor:pointer;width:max-content}
.leiste{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);box-shadow:0 -2px 10px rgba(0,0,0,.08);padding:10px 16px;z-index:5}
.leiste>div{max-width:860px;margin:0 auto;display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}
body.offen main{padding-bottom:88px}
dialog{border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--text);max-width:min(640px,calc(100vw - 32px));width:100%;padding:16px}
dialog::backdrop{background:rgba(0,0,0,.4)}
dialog ul{padding-left:18px;margin:8px 0}
dialog li{margin:4px 0;word-break:break-word}
.alt{color:var(--muted);text-decoration:line-through}
.farbvorschau{border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:8px;max-width:420px}
.farbvorschau .fkopf{padding:14px 16px;color:#fff;font-weight:600}
.farbvorschau .fband{height:8px}
.farbvorschau .fknopf{display:inline-block;margin:12px 16px;padding:6px 14px;border-radius:8px;font-weight:600}
.meldung button{margin-left:10px;min-height:32px;padding:4px 10px}
.qr{width:180px;height:180px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:6px;display:block;margin:8px 0}
code{word-break:break-all}
.check{list-style:none;padding:0;margin:0}
.check li{display:flex;gap:10px;align-items:baseline;padding:6px 0;border-top:1px solid var(--line)}
.check li:first-child{border-top:0}
.check .zeichen{flex:0 0 1.4em;font-weight:700}
.check .text{flex:1 1 auto}
.check button{min-height:32px;padding:4px 10px}
.schritte{margin:6px 0 0;padding-left:20px}
.schritte li{margin:4px 0}
.vliste td button{min-height:32px;padding:4px 10px;margin:2px 4px 2px 0}
.vliste a,.check a{color:var(--accent)}
.vliste .fremd{font-size:.8rem;color:var(--warn)}
textarea.block{font:12px/1.4 ui-monospace,monospace;min-height:220px}
.sichtbar{color:var(--muted);font-size:.8rem}
</style>
</head>
<body>
<main id="app"><p>Lädt …</p></main>
<noscript><main><p>Diese Seite braucht JavaScript.</p></main></noscript>
<script src="/settings/settings.js" defer></script>
</body>
</html>
`;
}

export const SETTINGS_JS = String.raw`(function () {
  'use strict';
  var app = document.getElementById('app');
  var csrf = '';
  var state = null;
  var aktiv = 'status';
  // Offene Änderungen je Schlüssel: { f, wert } — wert ist der Text der Anzeige
  // (Minuten statt Millisekunden), null heißt „auf die Umgebung zurücksetzen“.
  // Sie überleben jedes Neuzeichnen (Tab-Wechsel, Zurücksetzen, Fehler) und
  // gehen erst mit Speichern oder Verwerfen.
  var geaendert = {};
  var serverFehler = {};
  var ungueltig = {};
  // Die Mannschaftszeilen in Arbeit; null heißt: aus dem Stand (und den offenen Änderungen) lesen.
  var entwurf = null;
  var teamInfo = {};
  var protokollDaten = null;
  var protokollFilter = '';
  var fehlerZiele = {};
  var nachMannschaften = [];
  var farbenAktualisieren = null;
  var refs = {};
  var MANNSCHAFT_KEYS = ['TEAM_IDS', 'CLUBDESK_TEAMS', 'TEAM_GROUPS', 'SITE_PHOTOS'];
  // Der Mannschafts-Editor meldet hier, wie er nach einer Änderung von außen (Assistent) neu zeichnet.
  var editorAktualisieren = null;
  // Saisonwechsel-Assistent: zuletzt geholte Saisonprüfung und Vereinsliste — überleben das Neuzeichnen.
  var saisonStand = null;
  var vereinsStand = null;
  var saisonGeholt = false;

  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function api(method, pfad, body, hintergrund) {
    var opt = { method: method, credentials: 'same-origin', headers: {} };
    if (csrf) opt.headers['X-CSRF-Token'] = csrf;
    if (hintergrund) opt.headers['X-Hintergrund'] = '1';
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(pfad, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && pfad !== '/settings/api/login' && state) login('Die Sitzung ist abgelaufen. Offene Änderungen sind verloren.');
        return { status: r.status, body: j };
      });
    }, function () { return { status: 0, body: { message: 'Keine Verbindung zum Server.' } }; });
  }

  function zeit(iso, nurUhr) {
    if (!iso) return '–';
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    return nurUhr ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString('de-DE');
  }

  function anzahl() { return Object.keys(geaendert).length; }

  // ---------------------------------------------------------------- Anmeldung

  function login(meldung) {
    state = null; csrf = ''; geaendert = {}; entwurf = null; serverFehler = {}; ungueltig = {};
    document.body.classList.remove('offen');
    app.textContent = '';
    var user = el('input', { id: 'u', autocomplete: 'username', required: 'required' });
    var pw = el('input', { id: 'p', type: 'password', autocomplete: 'current-password', required: 'required' });
    var fehler = el('div', { class: 'err', role: 'alert', text: meldung || '' });
    var form = el('form', { onsubmit: function (ev) {
      ev.preventDefault();
      api('POST', '/settings/api/login', { user: user.value, password: pw.value }).then(function (r) {
        if (r.status === 200) { csrf = r.body.csrf; laden(); }
        else if (r.status === 429) fehler.textContent = 'Zu viele Versuche. Bitte eine Minute warten.';
        else fehler.textContent = r.body.message || 'Anmeldung fehlgeschlagen.';
      });
    } },
      el('label', { for: 'u', text: 'Name' }), user,
      el('label', { for: 'p', text: 'Passwort', style: 'margin-top:12px' }), pw,
      fehler,
      el('p', null, el('button', { class: 'primary', type: 'submit', text: 'Anmelden' })));
    app.appendChild(el('div', { class: 'card', style: 'max-width:380px;margin:48px auto' }, el('h1', { text: 'Handballteck · Einstellungen' }), form));
    user.focus();
  }

  function laden() {
    api('GET', '/settings/api/state').then(function (r) {
      if (r.status === 401) { login(); return; }
      if (r.status !== 200) { app.textContent = 'Fehler beim Laden.'; return; }
      state = r.body; csrf = state.csrf;
      protokollDaten = { zeilen: state.protokoll, anzahl: state.protokollAnzahl, offset: 0, seite: state.protokoll.length || 30 };
      aktiv = tabAusAdresse();
      zeichne();
    });
  }

  // ---------------------------------------------------------------- Werte

  function feldVon(key) { return state.felder.filter(function (x) { return x.key === key; })[0] || null; }

  function anzeigeWert(f, roh) {
    if (f.faktor && roh !== '' && roh !== null && !isNaN(Number(roh))) return String(Number(roh) / f.faktor);
    return roh === null || roh === undefined ? '' : roh;
  }

  function zuRohwert(f, anzeige) {
    if (f.faktor && anzeige.trim() !== '' && !isNaN(Number(anzeige.replace(',', '.')))) return String(Math.round(Number(anzeige.replace(',', '.')) * f.faktor));
    return anzeige;
  }

  function rohFuerServer(g) {
    if (g.wert === null) return null;
    return g.f.art === 'schalter' || g.f.versteckt || g.f.zeilen ? g.wert : zuRohwert(g.f, g.wert);
  }

  /** Der Rohwert, wie er nach dem Speichern gälte: offene Änderung, sonst der Stand. */
  function kuenftigRoh(key) {
    var f = feldVon(key);
    if (!f) return '';
    var g = geaendert[key];
    if (!g) return f.wert;
    if (g.wert === null) return f.umgebungWert || '';
    return rohFuerServer(g);
  }

  function schalterText(v) { return v === 'false' ? 'aus' : 'an'; }

  function wertText(f, roh) {
    if (f.art === 'geheim') return roh ? 'gesetzt' : 'nicht gesetzt';
    if (f.art === 'schalter') return schalterText(roh || f.standard);
    if (roh === '' || roh === null || roh === undefined) return '(leer)';
    return anzeigeWert(f, roh) + (f.einheit ? ' ' + f.einheit : '');
  }

  // ---------------------------------------------------------------- Tabs

  function reihe() { return ['status'].concat(Object.keys(state.gruppen)); }
  function tabName(g) { return g === 'status' ? 'Zustand' : state.gruppen[g]; }
  function tabAusAdresse() {
    var h = decodeURIComponent((location.hash || '').replace(/^#/, ''));
    return state && reihe().indexOf(h) >= 0 ? h : 'status';
  }

  function zeigeTab(g, fokus) {
    aktiv = g;
    reihe().forEach(function (x) {
      var t = refs.tabs[x], p = refs.panels[x];
      var an = x === g;
      t.setAttribute('aria-selected', an ? 'true' : 'false');
      t.tabIndex = an ? 0 : -1;
      p.hidden = !an;
    });
    if (fokus) refs.tabs[g].focus();
    if (location.hash !== '#' + g) history.replaceState(null, '', '#' + g);
  }

  window.addEventListener('hashchange', function () { if (state) zeigeTab(tabAusAdresse()); });

  // ---------------------------------------------------------------- Zähler und Leiste

  function aktualisiereZaehler() {
    if (!state || !refs.tabs) return;
    var jeGruppe = {};
    Object.keys(geaendert).forEach(function (k) { var g = geaendert[k].f.gruppe; jeGruppe[g] = (jeGruppe[g] || 0) + 1; });
    Object.keys(state.gruppen).forEach(function (g) {
      var z = refs.zahlen[g];
      z.textContent = jeGruppe[g] ? String(jeGruppe[g]) : '';
      z.hidden = !jeGruppe[g];
      refs.tabs[g].setAttribute('aria-label', tabName(g) + (jeGruppe[g] ? ', ' + jeGruppe[g] + ' ungespeichert' : ''));
    });
    var n = anzahl();
    refs.leiste.hidden = n === 0;
    document.body.classList.toggle('offen', n > 0);
    refs.leisteText.textContent = n === 1 ? '1 ungespeicherte Änderung' : n + ' ungespeicherte Änderungen';
  }

  function setzeAenderung(f, wert, start) {
    if (wert !== start) geaendert[f.key] = { f: f, wert: wert }; else delete geaendert[f.key];
    aktualisiereZaehler();
  }

  window.addEventListener('beforeunload', function (ev) {
    if (state && anzahl() > 0) { ev.preventDefault(); ev.returnValue = ''; }
  });

  document.addEventListener('keydown', function (ev) {
    if (!state) return;
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) { ev.preventDefault(); oeffneDialog(); }
  });

  // ---------------------------------------------------------------- Fehler und Live-Prüfung

  function setzeFehler(key, text) {
    if (text) serverFehler[key] = text; else delete serverFehler[key];
    var ziel = fehlerZiele[key];
    if (ziel) ziel();
  }

  var pruefTimer = {};
  function livePruefen(f) {
    clearTimeout(pruefTimer[f.key]);
    pruefTimer[f.key] = setTimeout(function () {
      var g = geaendert[f.key];
      if (!g || g.wert === null) { setzeFehler(f.key, ''); return; }
      api('POST', '/settings/api/check', { aenderungen: [{ key: f.key, wert: rohFuerServer(g) }] }).then(function (r) {
        if (r.status !== 200) return;
        // Nur übernehmen, wenn der Wert inzwischen nicht weitergetippt wurde.
        if (geaendert[f.key] !== g) return;
        setzeFehler(f.key, (r.body.fehler || {})[f.key] || '');
      });
    }, 400);
  }

  // ---------------------------------------------------------------- Hinweise

  /** Der erste Satz bleibt stehen, der Rest klappt unter „Mehr“ auf (Abkürzungen wie „z. B.“ trennen nicht). */
  function hinweisTeile(text) {
    var m = /^([\s\S]{20,}?[a-zäöüß)]{2}[.!?])\s+([A-ZÄÖÜ„/(][\s\S]*)$/.exec(text);
    return m ? [m[1], m[2]] : [text, ''];
  }

  // ---------------------------------------------------------------- Mannschaften

  function mannschaftenLesen(roh) {
    var out = [];
    String(roh || '').split(/[,;\n]+/).forEach(function (teil) {
      var t = teil.trim();
      if (!t) return;
      var i = t.indexOf('=');
      if (i >= 0) out.push({ id: t.slice(0, i).trim(), name: t.slice(i + 1).trim() });
      else t.split(/\s+/).forEach(function (id) { out.push({ id: id, name: '' }); });
    });
    return out;
  }
  function mannschaftenText(liste) {
    return liste.filter(function (m) { return m.id || m.name; }).map(function (m) { return m.name ? m.id + '=' + m.name : m.id; }).join(',');
  }
  function paareLesen(roh) {
    var out = {};
    String(roh || '').split(/[,;\n]+/).forEach(function (teil) {
      var i = teil.indexOf('=');
      if (i > 0) out[teil.slice(0, i).trim()] = teil.slice(i + 1).trim();
    });
    return out;
  }
  function clubdeskText(liste) {
    return liste.filter(function (m) { return m.id && m.slug; }).map(function (m) { return m.id + '=' + m.slug; }).join(',');
  }
  function fotosText(liste) {
    return liste.filter(function (m) { return m.id && (m.gruppe || m.spieler); }).map(function (m) {
      return m.id + '=' + [m.gruppe ? 'mannschaft' : null, m.spieler ? 'spieler' : null].filter(Boolean).join('+');
    }).join(',');
  }
  function bereicheText(liste) {
    return liste.filter(function (m) { return m.id && m.bereich; }).map(function (m) { return m.id + '=' + m.bereich; }).join(',');
  }
  /** Ein eingefügter Link der Mannschaftsseite (…/team/96254?season_id=…) wird zur Team-ID. */
  function teamIdAusEingabe(t) {
    var m = /\/team\/(\d{1,12})/.exec(t);
    return m ? m[1] : t.replace(/\s+/g, '');
  }
  /** Ein eingefügter Link der ClubDesk-Teamseite wird zu ihrem letzten Pfadteil (woelfe_1). */
  function slugAusEingabe(t) {
    var m = /\/teams-und-tabellen\/([a-z0-9_-]{1,40})/i.exec(t) || /^https?:\/\/[^/]+\/(?:[^?#]*\/)?([a-z0-9_-]{1,40})\/?(?:[?#].*)?$/i.exec(t);
    return m ? m[1] : t.trim();
  }
  function istJugend(m) {
    var b = m.bereich || (state.bereichAutomatisch || {})[m.id] || '';
    return b === 'jungen' || b === 'maedchen' || b === 'kinder';
  }

  function leereMannschaft() { return { id: '', name: '', bereich: '', slug: '', gruppe: false, spieler: false }; }

  /** Die Zeilen aus vier Einstellungen — mit offenen Änderungen (z. B. aus dem Protokoll wiederhergestellt). */
  function mannschaftenAusWerten(teams, clubdesk, bereiche, fotos) {
    var liste = mannschaftenLesen(teams);
    var slugs = paareLesen(clubdesk), gesetzt = paareLesen(bereiche), rechteJe = paareLesen(fotos);
    liste.forEach(function (m) {
      m.bereich = gesetzt[m.id] || '';
      m.slug = slugs[m.id] || '';
      var rechte = (rechteJe[m.id] || '').toLowerCase().split('+');
      m.gruppe = rechte.indexOf('mannschaft') >= 0;
      m.spieler = rechte.indexOf('spieler') >= 0;
    });
    return liste;
  }

  function aktuelleTeamIds() {
    var liste = entwurf || mannschaftenLesen(kuenftigRoh('TEAM_IDS'));
    return liste.map(function (m) { return m.id; }).filter(Boolean);
  }

  var infoTimer = null;
  function teamInfoZeigen(m, ziel) {
    ziel.textContent = '';
    ziel.className = '';
    if (!/^\d{3,12}$/.test(m.id)) return;
    var i = teamInfo[m.id];
    if (i) {
      if (i.ok) ziel.textContent = 'handball.net: ' + [i.name, i.liga, i.klasse].filter(Boolean).join(' · ');
      else { ziel.textContent = i.message; ziel.className = 'warn'; }
    }
  }
  function teamInfoHolen(m, ziel) {
    clearTimeout(infoTimer);
    teamInfoZeigen(m, ziel);
    if (!/^\d{3,12}$/.test(m.id) || teamInfo[m.id]) return;
    var id = m.id;
    infoTimer = setTimeout(function () {
      ziel.textContent = 'handball.net wird gefragt …';
      api('GET', '/settings/api/team/' + id).then(function (r) {
        if (r.status === 200) teamInfo[id] = r.body;
        if (m.id !== id) return;
        if (r.status === 200) teamInfoZeigen(m, ziel);
        else { ziel.textContent = r.body.message || 'handball.net nicht erreichbar.'; ziel.className = 'warn'; }
      });
    }, 600);
  }

  function mannschaftenEditor(f, ziel, fehlerBox, geaendertMelden) {
    var clubdeskFeld = feldVon('CLUBDESK_TEAMS');
    var fotosFeld = feldVon('SITE_PHOTOS');
    var bereichFeld = feldVon('TEAM_GROUPS');
    var startListe = mannschaftenAusWerten(f.wert, clubdeskFeld ? clubdeskFeld.wert : '', bereichFeld ? bereichFeld.wert : '', fotosFeld ? fotosFeld.wert : '');
    var startClubdesk = clubdeskText(startListe), startFotos = fotosText(startListe), startBereiche = bereicheText(startListe);
    if (!entwurf) entwurf = mannschaftenAusWerten(kuenftigRoh('TEAM_IDS'), kuenftigRoh('CLUBDESK_TEAMS'), kuenftigRoh('TEAM_GROUPS'), kuenftigRoh('SITE_PHOTOS'));
    var bereiche = state.bereiche || [];
    var automatisch = state.bereichAutomatisch || {};
    function wirksam(m) { return m.bereich || automatisch[m.id] || ''; }
    function rang(m) { var w = wirksam(m); var i = bereiche.map(function (b) { return b.id; }).indexOf(w); return i < 0 ? bereiche.length : i; }
    if (entwurf.length === 0) entwurf.push(leereMannschaft());
    function sortieren() {
      var mitIndex = entwurf.map(function (m, i) { return { m: m, i: i }; });
      mitIndex.sort(function (a, b) { return rang(a.m) - rang(b.m) || a.i - b.i; });
      var neu = mitIndex.map(function (x) { return x.m; });
      entwurf.length = 0;
      neu.forEach(function (m) { entwurf.push(m); });
    }
    sortieren();
    var behaelter = el('div');
    var meldungSeite = '';
    function pruefen() {
      var meldung = '';
      var gesehen = {};
      entwurf.forEach(function (m) {
        if (!m.id && !m.name) return;
        if (!/^\d{1,12}$/.test(m.id)) meldung = meldung || 'Die Team-ID besteht nur aus Ziffern, z. B. 96254.';
        else if (gesehen[m.id]) meldung = meldung || 'Die Team-ID ' + m.id + ' steht zweimal da.';
        gesehen[m.id] = true;
        if (/[,;\n]/.test(m.name) || m.name.length > 40) meldung = meldung || 'Der Name darf höchstens 40 Zeichen haben, ohne Komma und Semikolon.';
        if (m.slug && !/^[a-z0-9_-]{1,40}$/i.test(m.slug)) meldung = meldung || 'Die ClubDesk-Seite ist der letzte Teil der Adresse, z. B. woelfe_1.';
        if ((m.gruppe || m.spieler) && !m.slug) meldung = meldung || 'Fotos brauchen die ClubDesk-Seite der Mannschaft.';
      });
      if (meldung) ungueltig[f.key] = true; else delete ungueltig[f.key];
      meldungSeite = meldung;
      fehlerAnzeigen();
    }
    // Fehler der Seite und des Servers — auch zu den versteckten Feldern (ClubDesk, Bereiche, Fotos).
    function fehlerAnzeigen() {
      var texte = [];
      if (meldungSeite) texte.push(meldungSeite);
      MANNSCHAFT_KEYS.forEach(function (k) {
        if (!serverFehler[k]) return;
        var fk = feldVon(k);
        texte.push((k === 'TEAM_IDS' || !fk ? '' : fk.label + ': ') + serverFehler[k]);
      });
      fehlerBox.textContent = texte.join(' ');
      var box = fehlerBox.parentNode;
      if (box) box.classList.toggle('fehlerfeld', texte.length > 0);
    }
    MANNSCHAFT_KEYS.forEach(function (k) { fehlerZiele[k] = fehlerAnzeigen; });
    var gezogen = -1;
    function neuZeichnen() {
      behaelter.textContent = '';
      behaelter.appendChild(el('div', { class: 'mrow kopf', 'aria-hidden': 'true' }, el('span'), el('span', { text: 'Bereich' }), el('span', { text: 'Team-ID' }), el('span', { text: 'Name (leer: von handball.net)' }), el('span', { text: 'ClubDesk-Seite' }), el('span', { text: 'Fotos öffentlich' }), el('span')));
      var letzterRang = -1;
      entwurf.forEach(function (m, i) {
        var r = rang(m);
        var nr = i + 1;
        if (r !== letzterRang) {
          behaelter.appendChild(el('h4', { class: 'bereich', text: r < bereiche.length ? bereiche[r].label : 'Ohne Bereich' }));
          letzterRang = r;
        }
        var bereichWahl = el('select', { 'aria-label': 'Bereich, Mannschaft ' + nr });
        bereichWahl.appendChild(el('option', { value: '', text: 'automatisch' }));
        bereiche.forEach(function (b) { bereichWahl.appendChild(el('option', { value: b.id, text: b.label })); });
        bereichWahl.value = m.bereich;
        var idFeld = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '96254', 'aria-label': 'Team-ID, Mannschaft ' + nr });
        var nameFeld = el('input', { type: 'text', autocomplete: 'off', placeholder: 'z. B. B-Jugend', 'aria-label': 'Name, Mannschaft ' + nr });
        var slugFeld = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'z. B. woelfe_1', 'aria-label': 'ClubDesk-Seite, Mannschaft ' + nr });
        var gruppeFeld = el('input', { type: 'checkbox', 'aria-label': 'Mannschaftsbild öffentlich, Mannschaft ' + nr });
        var spielerFeld = el('input', { type: 'checkbox', 'aria-label': 'Spielerbilder öffentlich, Mannschaft ' + nr });
        var info = el('span', { 'aria-live': 'polite' });
        idFeld.value = m.id; nameFeld.value = m.name; slugFeld.value = m.slug; gruppeFeld.checked = m.gruppe; spielerFeld.checked = m.spieler;
        teamInfoZeigen(m, info);
        bereichWahl.addEventListener('change', function () { m.bereich = bereichWahl.value; sortieren(); neuZeichnen(); aenderung(); });
        idFeld.addEventListener('input', function () {
          var roh = idFeld.value.trim();
          var id = /\D/.test(roh) ? teamIdAusEingabe(roh) : roh;
          if (id !== roh && /^\d+$/.test(id)) { idFeld.value = id; zeigeMeldung('Team-ID ' + id + ' aus dem Link übernommen.', false); }
          m.id = idFeld.value.trim(); aenderung(); teamInfoHolen(m, info);
        });
        nameFeld.addEventListener('input', function () { m.name = nameFeld.value.trim(); aenderung(); });
        slugFeld.addEventListener('input', function () {
          var roh = slugFeld.value.trim();
          if (/^https?:/i.test(roh)) { var slug = slugAusEingabe(roh); if (slug !== roh) slugFeld.value = slug; }
          m.slug = slugFeld.value.trim(); aenderung();
        });
        gruppeFeld.addEventListener('change', function () { m.gruppe = gruppeFeld.checked; aenderung(); });
        spielerFeld.addEventListener('change', function () {
          if (spielerFeld.checked && !window.confirm('Porträts mit Namen werden öffentlich gezeigt — bei Jugendmannschaften Fotos von Kindern. Nur, wenn die Bildrechte mit Verein und Eltern geklärt sind. Wirklich einschalten?')) { spielerFeld.checked = false; return; }
          m.spieler = spielerFeld.checked; aenderung();
        });
        // Verschoben wird nur innerhalb des Bereichs — mit den Knöpfen oder am Griff gezogen.
        function schieben(d) {
          var j = i + d;
          if (j < 0 || j >= entwurf.length || rang(entwurf[j]) !== r) return;
          var x = entwurf[i]; entwurf[i] = entwurf[j]; entwurf[j] = x;
          neuZeichnen(); aenderung();
        }
        var griff = el('span', { class: 'griff', draggable: 'true', title: 'Ziehen zum Sortieren', 'aria-hidden': 'true', text: '⠿' });
        var vorschauLink = state.vorschau && state.teams.indexOf(m.id) >= 0
          ? el('a', { href: '/settings/vorschau?team=' + encodeURIComponent(m.id), target: '_blank', rel: 'noopener noreferrer', text: 'Vorschau öffnen', 'aria-label': 'Vorschau, Mannschaft ' + nr })
          : null;
        var zeile = el('div', { class: 'mrow' }, griff, bereichWahl, idFeld, nameFeld, slugFeld,
          el('span', { class: 'fotos' },
            el('label', null, gruppeFeld, 'Mannschaftsbild'),
            el('label', null, spielerFeld, 'Spielerbilder')),
          el('span', { class: 'knoepfe' },
            el('button', { type: 'button', text: '↑', 'aria-label': 'Im Bereich nach oben, Mannschaft ' + nr, onclick: function () { schieben(-1); } }),
            el('button', { type: 'button', text: '↓', 'aria-label': 'Im Bereich nach unten, Mannschaft ' + nr, onclick: function () { schieben(1); } }),
            el('button', { type: 'button', text: '✕', 'aria-label': 'Mannschaft ' + nr + ' entfernen', onclick: function () {
              var weg = entwurf.splice(i, 1)[0];
              if (entwurf.length === 0) entwurf.push(leereMannschaft());
              neuZeichnen(); aenderung();
              zeigeMeldung('Mannschaft ' + (weg.name || weg.id || nr) + ' entfernt.', false, { text: 'Rückgängig', fn: function () {
                if (entwurf.length === 1 && !entwurf[0].id && !entwurf[0].name) entwurf.length = 0;
                entwurf.splice(Math.min(i, entwurf.length), 0, weg);
                sortieren(); neuZeichnen(); aenderung();
                zeigeMeldung('Wieder da — noch nicht gespeichert.', false);
              } });
            } })),
          el('div', { class: 'minfo' }, info, vorschauLink));
        griff.addEventListener('dragstart', function (ev) { gezogen = i; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(i)); if (ev.dataTransfer.setDragImage) ev.dataTransfer.setDragImage(zeile, 10, 10); });
        griff.addEventListener('dragend', function () { gezogen = -1; });
        zeile.addEventListener('dragover', function (ev) {
          if (gezogen < 0 || gezogen === i || rang(entwurf[gezogen]) !== r) return;
          ev.preventDefault(); zeile.classList.add('ziel');
        });
        zeile.addEventListener('dragleave', function () { zeile.classList.remove('ziel'); });
        zeile.addEventListener('drop', function (ev) {
          ev.preventDefault(); zeile.classList.remove('ziel');
          if (gezogen < 0 || gezogen === i || rang(entwurf[gezogen]) !== r) return;
          var x = entwurf.splice(gezogen, 1)[0];
          entwurf.splice(i, 0, x);
          gezogen = -1;
          neuZeichnen(); aenderung();
        });
        behaelter.appendChild(zeile);
      });
      behaelter.appendChild(el('p', null, el('button', { type: 'button', text: '+ Mannschaft hinzufügen', onclick: function () {
        entwurf.push(leereMannschaft()); sortieren(); neuZeichnen();
        var felder = behaelter.querySelectorAll('input[inputmode=numeric]');
        for (var k = 0; k < felder.length; k++) if (!felder[k].value) { felder[k].focus(); break; }
      } })));
    }
    function nebenfeld(feld, start, text) {
      if (!feld) return;
      if (text !== start) geaendert[feld.key] = { f: feld, wert: text }; else delete geaendert[feld.key];
    }
    function aenderung() {
      ziel.value = mannschaftenText(entwurf);
      nebenfeld(clubdeskFeld, startClubdesk, clubdeskText(entwurf));
      nebenfeld(fotosFeld, startFotos, fotosText(entwurf));
      nebenfeld(bereichFeld, startBereiche, bereicheText(entwurf));
      MANNSCHAFT_KEYS.forEach(function (k) { delete serverFehler[k]; });
      pruefen();
      geaendertMelden();
      nachMannschaften.forEach(function (fn) { fn(); });
    }
    editorAktualisieren = function () { sortieren(); neuZeichnen(); aenderung(); };
    neuZeichnen();
    ziel.value = mannschaftenText(entwurf);
    // Offene Änderungen der versteckten Felder an den Entwurf angleichen (z. B. nach einem Wiederherstellen).
    nebenfeld(clubdeskFeld, startClubdesk, clubdeskText(entwurf));
    nebenfeld(fotosFeld, startFotos, fotosText(entwurf));
    nebenfeld(bereichFeld, startBereiche, bereicheText(entwurf));
    pruefen();
    return behaelter;
  }

  // ---------------------------------------------------------------- Ein Feld

  function feldZeile(f) {
    var id = 'f_' + f.key;
    var g = geaendert[f.key];
    var zurueck = Boolean(g && g.wert === null);
    var start, eingabe, lesen;
    var umgebungAnzeige = anzeigeWert(f, f.umgebungWert || '');
    var schalterText2 = null;
    if (f.art === 'schalter') {
      start = (f.wert || f.standard) === 'false' ? 'false' : 'true';
      eingabe = el('input', { id: id, type: 'checkbox', role: 'switch', class: 'schalter' });
      var anfang = zurueck ? ((f.umgebungWert || f.standard) === 'false' ? 'false' : 'true') : g ? g.wert : start;
      eingabe.checked = anfang === 'true';
      schalterText2 = el('span', { text: schalterText(anfang), 'aria-hidden': 'true' });
      lesen = function () { return eingabe.checked ? 'true' : 'false'; };
    } else if (f.zeilen === 'mannschaften') {
      start = mannschaftenText(mannschaftenLesen(f.wert));
      eingabe = el('input', { id: id, type: 'hidden' });
      lesen = function () { return eingabe.value; };
    } else if (f.optionen) {
      start = f.wert || f.standard;
      eingabe = el('select', { id: id });
      f.optionen.forEach(function (o) { eingabe.appendChild(el('option', { value: o, text: o + (o === f.standard ? ' (Standard)' : '') })); });
      eingabe.value = zurueck ? (f.umgebungWert || f.standard) : g ? g.wert : start;
      lesen = function () { return eingabe.value; };
    } else if (f.lang) {
      start = anzeigeWert(f, f.wert);
      eingabe = el('textarea', { id: id, spellcheck: 'false' });
      eingabe.value = zurueck ? umgebungAnzeige : g ? g.wert : start;
      lesen = function () { return eingabe.value; };
    } else if (f.art === 'geheim') {
      start = '';
      eingabe = el('input', { id: id, type: 'password', autocomplete: 'new-password', placeholder: g && g.entfernen ? 'wird beim Speichern entfernt' : f.gesetzt ? 'gesetzt — zum Ersetzen neuen Wert eingeben' : 'nicht gesetzt' });
      if (g && !g.entfernen && g.wert) eingabe.value = g.wert;
      lesen = function () { return eingabe.value; };
    } else {
      start = anzeigeWert(f, f.wert);
      var zahl = f.min !== null && f.min !== undefined;
      var faktor = f.faktor || 1;
      eingabe = el('input', {
        id: id, type: zahl ? 'number' : 'text', inputmode: zahl ? 'numeric' : null, autocomplete: 'off', spellcheck: 'false',
        min: zahl ? String(f.nullErlaubt ? 0 : f.min / faktor) : null, max: zahl ? String(f.max / faktor) : null, step: zahl ? '1' : null,
      });
      eingabe.value = zurueck ? umgebungAnzeige : g ? g.wert : start;
      lesen = function () { return eingabe.value; };
    }
    // Ein vorgemerkter Wert, der dem Stand gleicht, ist keine Änderung.
    if (g && g.wert !== null && !g.entfernen && f.zeilen !== 'mannschaften' && g.wert === start) { delete geaendert[f.key]; g = null; }
    if (zurueck) eingabe.disabled = true;

    var hinweisId = id + '_h', fehlerId = id + '_e';
    var fehler = el('div', { class: 'err', id: fehlerId, role: 'alert' });
    var box = el('div', { class: 'feld', 'data-key': f.key });
    eingabe.setAttribute('aria-describedby', hinweisId + ' ' + fehlerId);
    var quelle = f.quelle === 'seite' ? 'von dieser Seite' : f.quelle === 'umgebung' ? 'aus der Umgebung' : 'Standard';
    var kopf = el('label', { for: id, text: f.label + (f.einheit ? ' (' + f.einheit + ')' : '') },
      el('span', { class: 'badge' + (f.quelle === 'seite' ? ' seite' : ''), text: quelle }));
    var zeile = el('div', { class: 'zeile' }, eingabe, schalterText2);
    function fehlerZeigen() {
      if (f.zeilen === 'mannschaften') return;
      var text = serverFehler[f.key] || '';
      fehler.textContent = text;
      box.classList.toggle('fehlerfeld', Boolean(text));
      if (text) eingabe.setAttribute('aria-invalid', 'true'); else eingabe.removeAttribute('aria-invalid');
    }
    fehlerZiele[f.key] = fehlerZeigen;

    function markiere() {
      if (zurueck) return;
      var neu = lesen();
      if (schalterText2) schalterText2.textContent = schalterText(neu);
      if (f.art === 'geheim' && geaendert[f.key] && geaendert[f.key].entfernen && neu === '') return;
      setzeAenderung(f, neu, start);
      if (f.zeilen !== 'mannschaften') livePruefen(f);
      if ((f.art === 'farbe' || f.key === 'CLUB_NAME') && farbenAktualisieren) farbenAktualisieren();
      if (f.key === 'CLUB_TEAM_IDS') doppeltPruefen();
    }

    if (f.zeilen === 'mannschaften') {
      zeile = zurueck
        ? el('div', null, eingabe, el('p', { class: 'hint', text: 'Nach dem Speichern gelten die Mannschaften aus der Umgebung.' }))
        : el('div', null, eingabe, mannschaftenEditor(f, eingabe, fehler, markiere));
    }
    if (f.art === 'farbe') {
      var pick = el('input', { type: 'color', 'aria-label': f.label + ' wählen' });
      var vorschau = function () { pick.value = /^#[0-9a-fA-F]{6}$/.test(eingabe.value) ? eingabe.value : f.standard; };
      vorschau();
      if (zurueck) pick.disabled = true;
      pick.addEventListener('input', function () { eingabe.value = pick.value; markiere(); });
      eingabe.addEventListener('input', vorschau);
      zeile.appendChild(pick);
    }
    if (f.key === 'TELEGRAM_BOT_TOKEN' && !zurueck) {
      zeile.appendChild(el('button', { type: 'button', text: 'Token prüfen', onclick: function (ev) {
        var knopf = ev.currentTarget;
        knopf.disabled = true;
        api('POST', '/settings/api/test/token', { token: eingabe.value.trim() }).then(function (r) {
          knopf.disabled = false;
          if (r.status === 200) zeigeMeldung('Der Token gehört zum Bot ' + (r.body.username ? '@' + r.body.username : r.body.name || '(ohne Namen)') + (eingabe.value.trim() ? ' — jetzt speichern, dann meldet er sich an.' : ' (gespeicherter Token).'), false);
          else zeigeMeldung(r.body.message || 'Token-Prüfung gescheitert.', true);
        });
      } }));
    }
    if (f.art === 'geheim' && !zurueck) {
      if (f.erzeugbar) zeile.appendChild(el('button', { type: 'button', text: 'Erzeugen', onclick: function () {
        var b = new Uint8Array(24); crypto.getRandomValues(b);
        eingabe.value = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
        eingabe.type = 'text';
        delete geaendert[f.key];
        markiere();
      } }));
      if (f.gesetzt) zeile.appendChild(el('button', { type: 'button', text: 'Entfernen', onclick: function () {
        eingabe.value = ''; eingabe.placeholder = 'wird beim Speichern entfernt';
        geaendert[f.key] = { f: f, wert: '', entfernen: true };
        setzeFehler(f.key, '');
        aktualisiereZaehler();
      } }));
    }
    var doppelt = null;
    function doppeltPruefen() {
      if (!doppelt) return;
      var eigene = aktuelleTeamIds();
      var ids = String(eingabe.value).split(/[^\d]+/).filter(function (x) { return x && eigene.indexOf(x) >= 0; });
      doppelt.textContent = ids.length ? 'Steht schon in der Tabelle der Mannschaften und heißt dort ohnehin so: ' + ids.join(', ') + '.' : '';
    }
    if (f.key === 'CLUB_TEAM_IDS') {
      doppelt = el('p', { class: 'hint warn', 'aria-live': 'polite' });
      nachMannschaften.push(doppeltPruefen);
    }
    eingabe.addEventListener('input', markiere);
    eingabe.addEventListener('change', markiere);
    box.appendChild(kopf); box.appendChild(zeile);

    if (f.key === 'TELEGRAM_ADMIN_CHAT_IDS' && state.chats && state.chats.length && !zurueck) {
      var auswahl = el('div');
      state.chats.forEach(function (c) {
        var kb = el('input', { type: 'checkbox' });
        var ids = function () { return String(eingabe.value).split(/[\s,;]+/).filter(Boolean); };
        kb.checked = ids().indexOf(c.id) >= 0;
        kb.addEventListener('change', function () {
          var liste = ids().filter(function (x) { return x !== c.id; });
          if (kb.checked) liste.push(c.id);
          eingabe.value = liste.join(', ');
          markiere();
        });
        auswahl.appendChild(el('label', { style: 'font-weight:400;display:flex;gap:8px;align-items:center' }, kb, (c.name || 'ohne Namen') + ' (' + c.id + ')'));
      });
      box.appendChild(el('details', { class: 'mehr' }, el('summary', { text: 'Aus den Abonnenten wählen (' + state.chats.length + ')' }), auswahl));
    }

    var teile = hinweisTeile(f.hinweis);
    var hinweis = el('div', { id: hinweisId });
    hinweis.appendChild(el('p', { class: 'hint', text: teile[0] }));
    if (teile[1]) hinweis.appendChild(el('details', { class: 'mehr' }, el('summary', { text: 'Mehr' }), el('p', { class: 'hint', text: teile[1] })));
    var wirk = { 'sofort': 'Wirkt sofort', 'abruf': 'Wirkt beim nächsten Abruf (wird beim Speichern angestoßen)', 'naechster-takt': 'Wirkt ab dem nächsten Takt' }[f.wirkung];
    var standard = f.art === 'schalter' ? schalterText(f.standard) : f.standard ? anzeigeWert(f, f.standard) + (f.einheit ? ' ' + f.einheit : '') : '';
    hinweis.appendChild(el('p', { class: 'hint', text: (standard ? 'Standard: ' + standard + ' · ' : '') + wirk + '.' + (f.sichtbar ? ' Zu sehen: ' + f.sichtbar + '.' : '') }));
    box.appendChild(hinweis);
    if (doppelt) { box.appendChild(doppelt); doppeltPruefen(); }

    if (zurueck) {
      box.appendChild(el('p', { class: 'hint warn' },
        'Wird beim Speichern auf die Umgebung zurückgesetzt' + (f.art === 'geheim' ? '.' : ' (' + wertText(f, f.umgebungWert) + ').') + ' ',
        el('button', { type: 'button', text: 'Doch nicht', onclick: function () { delete geaendert[f.key]; neuZeichnen(); } })));
    } else if (f.quelle === 'seite') {
      box.appendChild(el('p', { class: 'hint' },
        f.art === 'geheim' ? '' : 'Die Umgebung sagt: ' + wertText(f, f.umgebungWert) + '. ',
        el('button', { type: 'button', text: 'Auf die Umgebung zurücksetzen', onclick: function () {
          geaendert[f.key] = { f: f, wert: null };
          if (f.zeilen === 'mannschaften') entwurf = null;
          setzeFehler(f.key, '');
          neuZeichnen();
        } })));
    }
    box.appendChild(fehler);
    if (f.zeilen === 'mannschaften') { if (fehlerZiele[f.key]) fehlerZiele[f.key](); } else fehlerZeigen();
    return box;
  }

  // ---------------------------------------------------------------- Farben

  function luminanz(hex) {
    var c = [1, 3, 5].map(function (i) {
      var v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function kontrast(a, b) {
    var la = luminanz(a), lb = luminanz(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function farbeVon(key) {
    var f = feldVon(key);
    var v = kuenftigRoh(key);
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : f.standard;
  }

  function farbVorschau() {
    var kopf = el('div', { class: 'fkopf' });
    var band = el('div', { class: 'fband' });
    var knopf = el('span', { class: 'fknopf', text: 'Benachrichtigen' });
    var unten = el('div', null, knopf);
    var befund = el('ul', { class: 'hint', 'aria-live': 'polite' });
    farbenAktualisieren = function () {
      var h = farbeVon('PRIMARY_COLOR'), z = farbeVon('SECONDARY_COLOR'), a = farbeVon('ACCENT_COLOR');
      kopf.textContent = (kuenftigRoh('CLUB_NAME') || feldVon('CLUB_NAME').standard) + ' · Nächstes Spiel';
      kopf.style.background = h; band.style.background = z; unten.style.background = h;
      knopf.style.background = a; knopf.style.color = h;
      befund.textContent = '';
      [['Weiße Schrift auf der Hauptfarbe', kontrast(h, '#ffffff'), 4.5],
       ['Weiße Schrift auf der Zweitfarbe', kontrast(z, '#ffffff'), 4.5],
       ['Akzentfarbe auf der Hauptfarbe', kontrast(a, h), 3]].forEach(function (p) {
        var gut = p[1] >= p[2];
        befund.appendChild(el('li', { class: gut ? 'ok' : 'warn', text: p[0] + ': ' + p[1].toFixed(1) + ':1 ' + (gut ? '— gut lesbar.' : '— zu schwach, mindestens ' + p[2] + ':1 (WCAG).') }));
      });
    };
    farbenAktualisieren();
    return el('div', { class: 'feld' }, el('label', { text: 'Vorschau' }),
      el('div', { class: 'farbvorschau', 'aria-hidden': 'true' }, kopf, band, unten), befund);
  }

  // ---------------------------------------------------------------- Zusätze je Bereich

  function telegramZusatz() {
    var bot = state.status.bot;
    var box = el('div', { class: 'feld' }, el('label', { text: 'Einladungslink' }));
    if (bot.link) {
      var kopieren = el('button', { type: 'button', text: 'Kopieren', onclick: function () {
        if (navigator.clipboard) navigator.clipboard.writeText(bot.link).then(function () { zeigeMeldung('Link kopiert.', false); }, function () { zeigeMeldung('Kopieren nicht erlaubt — bitte von Hand markieren.', true); });
      } });
      box.appendChild(el('div', { class: 'zeile' }, el('code', { text: bot.link }), kopieren,
        el('a', { class: 'btn', href: '/settings/api/qr.svg', download: 'einladung-qr.svg', text: 'QR-Code laden' })));
      box.appendChild(el('img', { class: 'qr', src: '/settings/api/qr.svg', alt: 'QR-Code des Einladungslinks', width: '180', height: '180' }));
      if (geaendert.TELEGRAM_INVITE_CODE) box.appendChild(el('p', { class: 'hint warn', text: 'Link und QR-Code zeigen den gespeicherten Einladungscode; der neue gilt erst nach dem Speichern.' }));
    } else {
      box.appendChild(el('p', { class: 'hint', text: bot.an ? 'Erscheint, sobald der Bot bei Telegram angemeldet ist.' : 'Kein Bot-Token gesetzt — erst dann gibt es einen Link.' }));
    }
    var test = el('button', { type: 'button', text: 'Testnachricht an die Admin-Chats', disabled: bot.an ? null : 'disabled', onclick: function () {
      test.disabled = true;
      api('POST', '/settings/api/test/telegram').then(function (r) {
        test.disabled = false;
        if (r.status === 200) zeigeMeldung(r.body.ok + ' Testnachricht(en) verschickt' + (r.body.fehler.length ? '; gescheitert: ' + r.body.fehler.join('; ') : '.'), r.body.fehler.length > 0);
        else zeigeMeldung(r.body.message || 'Testnachricht nicht möglich.', true);
      });
    } });
    return el('div', null, box, el('div', { class: 'feld' }, el('label', { text: 'Verbindung prüfen' }), el('p', null, test),
      el('p', { class: 'hint', text: 'Geht an die gespeicherten Admin-Chats; prüft Token und Chat-IDs auf einmal.' })));
  }

  function base64ZuBytes(b64) {
    var pad = '='.repeat((4 - b64.length % 4) % 4);
    var roh = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(roh.length);
    for (var i = 0; i < roh.length; i++) out[i] = roh.charCodeAt(i);
    return out;
  }

  function aktiveRegistrierung(reg) {
    if (reg.active) return Promise.resolve(reg);
    return new Promise(function (ok) {
      var w = reg.installing || reg.waiting;
      if (!w) { ok(reg); return; }
      w.addEventListener('statechange', function () { if (w.state === 'activated') ok(reg); });
    });
  }

  function testPush(knopf) {
    if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window)) { zeigeMeldung('Web-Push geht nur über https (oder localhost) in einem Browser, der es kann.', true); return; }
    if (!state.vapidKey) { zeigeMeldung('Web-Push ist nicht eingerichtet (kein VAPID-Schlüssel).', true); return; }
    knopf.disabled = true;
    var fertig = function (text, fehler) { knopf.disabled = false; zeigeMeldung(text, fehler); };
    Notification.requestPermission().then(function (erlaubt) {
      if (erlaubt !== 'granted') { fertig('Benachrichtigungen sind für diese Seite nicht erlaubt.', true); return; }
      return navigator.serviceWorker.register('/settings/sw.js', { scope: '/settings/' }).then(aktiveRegistrierung).then(function (reg) {
        return reg.pushManager.getSubscription().then(function (sub) {
          return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ZuBytes(state.vapidKey) });
        });
      }).then(function (sub) {
        var j = sub.toJSON();
        return api('POST', '/settings/api/test/push', { endpoint: j.endpoint, keys: j.keys });
      }).then(function (r) {
        if (r.status === 200) fertig('Test-Push verschickt — er sollte gleich erscheinen.', false);
        else fertig(r.body.message || 'Test-Push gescheitert.', true);
      });
    }).catch(function (err) { fertig('Test-Push gescheitert: ' + (err && err.message ? err.message : err), true); });
  }

  function einbettenZusatz() {
    var farbe = el('select', { 'aria-label': 'Farbschema der eingebetteten Seite' },
      el('option', { value: '', text: 'wie das Gerät des Besuchers' }), el('option', { value: 'dunkel', text: 'immer dunkel' }), el('option', { value: 'hell', text: 'immer hell' }));
    var block = el('textarea', { class: 'block', readonly: 'readonly', spellcheck: 'false', 'aria-label': 'Block zum Einfügen in die Vereinsseite' });
    var warnung = el('p', { class: 'hint warn' });
    function holen() {
      api('GET', '/settings/api/einbettung' + (farbe.value ? '?farbe=' + farbe.value : '')).then(function (r) {
        if (r.status !== 200) return;
        block.value = r.body.block;
        warnung.textContent = r.body.erlaubt.length ? '' : 'Noch keine Vereinsseite unter „Einbetten erlauben“ gespeichert — bis dahin zeigt der Rahmen nichts.';
      });
    }
    farbe.addEventListener('change', holen);
    holen();
    var kopieren = el('button', { type: 'button', text: 'Block kopieren', onclick: function () {
      block.select();
      if (navigator.clipboard) navigator.clipboard.writeText(block.value).then(function () { zeigeMeldung('Block kopiert — in einen HTML-Baustein der Vereinsseite einfügen.', false); }, function () { zeigeMeldung('Kopieren nicht erlaubt — bitte von Hand markieren.', true); });
    } });
    return el('div', { class: 'feld' }, el('label', { text: 'Einbetten in die Vereinsseite' }),
      el('p', { class: 'hint', text: 'Diesen Block als HTML-Baustein in die Vereinsseite einfügen (Rahmen, Ausweichlink und Skript gehören zusammen). Er zeigt die Microsite kompakt ohne eigenes Logo; das Skript passt die Höhe an.' }),
      el('div', { class: 'zeile' }, farbe, kopieren), block, warnung);
  }

  function fortgeschrittenHinweis() {
    return el('p', { class: 'hint', text: 'Diese Werte passen für fast jeden Verein. Nur ändern, wenn es einen Grund gibt — etwa bei Fehlersuche oder wenn handball.net zu oft gefragt wird.' });
  }

  // ---------------------------------------------------------------- Saisonwechsel-Assistent

  function saisonText(n) { return /^saison/i.test(n || '') ? n : 'Saison ' + n; }
  function geschlechtText(g) { return g === 'M' ? 'männlich' : g === 'F' ? 'weiblich' : ''; }
  function klasseText(t) { return [t.age ? t.age.charAt(0) + t.age.slice(1).toLowerCase() : '', geschlechtText(t.gender)].filter(Boolean).join(' · '); }

  function saisonHolen(danach) {
    saisonGeholt = true;
    return api('GET', '/settings/api/saison', undefined, true).then(function (r) {
      saisonStand = r.status === 200 ? r.body : { fehler: r.body.message || 'Saisonprüfung gescheitert.' };
      if (danach) danach();
    });
  }

  function vereineHolen(danach) {
    return api('GET', '/settings/api/vereine').then(function (r) {
      vereinsStand = r.status === 200 ? r.body : { fehler: r.body.message || 'Vereinsliste gescheitert.' };
      if (danach) danach();
    });
  }

  function clubTeamIdsKuenftig() { return String(kuenftigRoh('CLUB_TEAM_IDS') || '').split(/[^\d]+/).filter(Boolean); }

  function alsFremdVormerken(id) {
    var f = feldVon('CLUB_TEAM_IDS');
    var liste = clubTeamIdsKuenftig().filter(function (x) { return x !== id; });
    liste.push(id);
    geaendert[f.key] = { f: f, wert: liste.join(',') };
    neuZeichnen();
    zeigeMeldung('Mannschaft ' + id + ' erscheint künftig unter dem Vereinsnamen — noch nicht gespeichert.', false);
  }

  function mannschaftHinzufuegen(t) {
    if (!editorAktualisieren || !entwurf) { zeigeMeldung('Die Mannschaften werden gerade zurückgesetzt — erst speichern oder „Doch nicht“.', true); return; }
    if (entwurf.some(function (m) { return m.id === t.id; })) return;
    for (var i = entwurf.length - 1; i >= 0; i--) if (!entwurf[i].id && !entwurf[i].name) entwurf.splice(i, 1);
    entwurf.push({ id: t.id, name: '', bereich: '', slug: '', gruppe: false, spieler: false });
    teamInfo[t.id] = teamInfo[t.id] || { ok: true, name: t.name, liga: klasseText(t) };
    editorAktualisieren();
    zeigeMeldung((t.name || t.id) + ' (' + klasseText(t) + ') hinzugefügt — noch nicht gespeichert.', false);
  }

  /** Alte Team-ID durch die neue ersetzen: Name, Bereich und ClubDesk-Seite bleiben; Fotos der Jugend neu freigeben. */
  function mannschaftErsetzen(altId, t) {
    if (!editorAktualisieren || !entwurf) return;
    var m = entwurf.filter(function (x) { return x.id === altId; })[0];
    if (!m) return;
    var jugend = istJugend(m);
    m.id = t.id;
    var fotosWeg = jugend && (m.gruppe || m.spieler);
    if (jugend) { m.gruppe = false; m.spieler = false; }
    teamInfo[t.id] = teamInfo[t.id] || { ok: true, name: t.name, liga: klasseText(t) };
    editorAktualisieren();
    zeigeMeldung('Team-ID ' + altId + ' → ' + t.id + ' vorgemerkt (Name, Bereich und ClubDesk-Seite bleiben).' + (fotosWeg ? ' Die Foto-Freigabe der Jugend bitte für die neue Saison neu setzen.' : '') + ' Noch nicht gespeichert.', false);
  }

  function saisonAssistent() {
    var box = el('div', { class: 'card', id: 'saisonwechsel' }, el('h2', { text: 'Saisonwechsel und Vereinsliste' }));
    box.appendChild(el('details', { class: 'mehr' }, el('summary', { text: 'So geht der Saisonwechsel (5 Schritte)' }),
      el('ol', { class: 'schritte' },
        el('li', { text: 'Einmalig: oben unter „Vereinsseiten bei handball.net“ den Link der Vereinsseite eintragen (bei einer Spielvereinigung auch die der Stammvereine) und speichern.' }),
        el('li', { text: '„Prüfen und Vereinsliste laden“ drücken. Rot markierte Mannschaften haben in der neuen Saison keine Spiele mehr unter ihrer Team-ID.' }),
        el('li', { text: 'Für jede rote Mannschaft in der Liste die passende neue wählen und „Ersetzen“ — Name, Bereich und ClubDesk-Seite bleiben erhalten. Neue Mannschaften mit „Hinzufügen“ übernehmen, alte mit ✕ entfernen.' }),
        el('li', { text: 'Bei Jugendmannschaften die Foto-Häkchen neu setzen, sobald die Freigaben für die neue Saison vorliegen.' }),
        el('li', { text: 'Speichern. Der Abruf startet sofort; mit „Vorschau öffnen“ die Seite ansehen.' }))));
    var knopf = el('button', { type: 'button', class: 'primary', text: 'Prüfen und Vereinsliste laden' });
    var ausgabe = el('div', { 'aria-live': 'polite' });
    knopf.addEventListener('click', function () {
      knopf.disabled = true; knopf.textContent = 'handball.net wird gefragt …';
      var fertig = function () { knopf.disabled = false; knopf.textContent = 'Erneut prüfen'; zeichneAusgabe(); };
      saisonHolen(function () { if (state.vereine > 0) vereineHolen(fertig); else { vereinsStand = null; fertig(); } });
    });
    box.appendChild(el('p', null, knopf));
    if (state.vereine === 0) box.appendChild(el('p', { class: 'hint warn', text: 'Ohne eingetragene Vereinsseite prüft der Knopf nur die vorhandenen Mannschaften; die Liste zum Hinzufügen und Ersetzen fehlt dann.' }));
    box.appendChild(ausgabe);

    function zeichneAusgabe() {
      ausgabe.textContent = '';
      var vorgemerkt = (entwurf || []).map(function (m) { return m.id; });
      var fremd = clubTeamIdsKuenftig();
      var kandidaten = vereinsStand && vereinsStand.teams ? vereinsStand.teams.filter(function (t) { return vorgemerkt.indexOf(t.id) < 0; }) : [];
      if (saisonStand) {
        if (saisonStand.fehler) ausgabe.appendChild(el('p', { class: 'err', text: saisonStand.fehler }));
        else {
          var schlecht = saisonStand.teams.filter(function (t) { return !t.ok; });
          ausgabe.appendChild(el('p', { class: schlecht.length ? 'warn' : 'ok', text: 'Laufend bei handball.net: ' + saisonText(saisonStand.saison) + '. ' + (schlecht.length ? schlecht.length + ' von ' + saisonStand.teams.length + ' Mannschaften ohne Spiele.' : 'Alle ' + saisonStand.teams.length + ' Mannschaften haben Spiele.') }));
          var tab = el('table');
          tab.appendChild(el('tr', null, el('th', { text: 'Eingetragen' }), el('th', { text: 'handball.net sagt' }), el('th', { text: '' })));
          saisonStand.teams.forEach(function (t) {
            var aktion = null;
            if (!t.ok && vorgemerkt.indexOf(t.id) >= 0 && kandidaten.length) {
              var wahl = el('select', { 'aria-label': 'Neue Mannschaft für ' + (t.name || t.id) }, el('option', { value: '', text: 'ersetzen durch …' }));
              kandidaten.forEach(function (k) { wahl.appendChild(el('option', { value: k.id, text: k.name + ' · ' + klasseText(k) + ' (' + k.id + ')' })); });
              aktion = el('span', { class: 'zeile' }, wahl, el('button', { type: 'button', text: 'Ersetzen', onclick: function () {
                var k = kandidaten.filter(function (x) { return x.id === wahl.value; })[0];
                if (k) { mannschaftErsetzen(t.id, k); zeichneAusgabe(); }
              } }));
            } else if (!t.ok && vorgemerkt.indexOf(t.id) < 0) aktion = el('span', { class: 'hint', text: 'vorgemerkt: ersetzt oder entfernt' });
            tab.appendChild(el('tr', null, el('td', { text: (t.name || '') + ' (' + t.id + ')' }), el('td', { class: t.ok ? 'ok' : 'warn', text: t.ok ? t.info : 'keine Spiele in dieser Saison' }), el('td', null, aktion)));
          });
          ausgabe.appendChild(tab);
        }
      }
      if (vereinsStand) {
        if (vereinsStand.fehler && !vereinsStand.teams) { ausgabe.appendChild(el('p', { class: 'err', text: vereinsStand.fehler })); return; }
        (vereinsStand.fehler || []).forEach(function (f) { ausgabe.appendChild(el('p', { class: 'err', text: 'Verein ' + f.verein + ': ' + f.message })); });
        ausgabe.appendChild(el('h3', { text: 'Mannschaften der Vereinsseiten (' + vereinsStand.teams.length + ')', style: 'font-size:1rem;margin:16px 0 6px' }));
        var liste = el('table', { class: 'vliste' });
        liste.appendChild(el('tr', null, el('th', { text: 'Mannschaft' }), el('th', { text: 'Klasse' }), el('th', { text: 'Team-ID' }), el('th', { text: '' })));
        vereinsStand.teams.forEach(function (t) {
          var drin = vorgemerkt.indexOf(t.id) >= 0;
          var alsFremd = fremd.indexOf(t.id) >= 0;
          var aktionen = el('span');
          if (drin) aktionen.appendChild(el('span', { class: 'ok', text: '✓ verfolgt' }));
          else {
            aktionen.appendChild(el('button', { type: 'button', text: 'Hinzufügen', title: 'Handballteck verfolgt diese Mannschaft (Seite, Bot, Kalender)', onclick: function () { mannschaftHinzufuegen(t); zeichneAusgabe(); } }));
            if (t.fremderName && !alsFremd) aktionen.appendChild(el('button', { type: 'button', text: 'Nur Vereinsnamen geben', title: 'Nicht verfolgen, aber in Tabellen und Spielplänen unter dem Vereinsnamen zeigen', onclick: function () { alsFremdVormerken(t.id); } }));
            if (alsFremd) aktionen.appendChild(el('span', { class: 'hint', text: 'trägt den Vereinsnamen' }));
          }
          liste.appendChild(el('tr', null,
            el('td', null, t.name, t.fremderName ? el('div', { class: 'fremd', text: 'tritt an als ' + (t.clubName || t.clubId) }) : null),
            el('td', { text: klasseText(t) }),
            el('td', null, el('a', { href: 'https://www.handball.net/team/' + t.id, target: '_blank', rel: 'noopener noreferrer', text: t.id })),
            el('td', null, aktionen)));
        });
        ausgabe.appendChild(liste);
      }
    }
    zeichneAusgabe();
    return box;
  }

  function micrositeZusatz() {
    var knopf = el('button', { type: 'button', text: 'Test-Push an diesen Browser' });
    knopf.addEventListener('click', function () { testPush(knopf); });
    return el('div', { class: 'feld' }, el('label', { text: 'Web-Push prüfen' }), el('p', null, knopf),
      el('p', { class: 'hint', text: state.vapidKey ? 'Meldet nur diesen Browser an und schickt ihm eine Nachricht; gespeichert wird die Anmeldung nicht.' : 'Web-Push ist nicht eingerichtet.' }));
  }

  // ---------------------------------------------------------------- Speichern

  function zeigeMeldung(text, fehler, aktion) {
    if (!refs.meldung) return;
    refs.meldung.textContent = text;
    refs.meldung.className = 'meldung ' + (fehler ? 'err' : 'ok');
    refs.meldung.hidden = false;
    if (aktion) refs.meldung.appendChild(el('button', { type: 'button', text: aktion.text, onclick: function () { aktion.fn(); } }));
  }

  function zuGruppe(key) {
    var f = feldVon(key);
    return f ? f.gruppe : null;
  }

  function ersterFehler() {
    var keys = Object.keys(serverFehler).filter(function (k) { return geaendert[k] || MANNSCHAFT_KEYS.indexOf(k) >= 0; });
    if (Object.keys(ungueltig).length) keys.unshift('TEAM_IDS');
    return keys[0] || null;
  }

  function oeffneDialog() {
    if (anzahl() === 0) return;
    var fk = ersterFehler();
    if (fk) {
      zeigeTab(zuGruppe(fk) || aktiv);
      var box = document.querySelector('.feld[data-key="' + (feldVon(fk).versteckt ? 'TEAM_IDS' : fk) + '"]');
      if (box) box.scrollIntoView({ block: 'center' });
      zeigeMeldung('Bitte die markierten Felder prüfen.', true);
      return;
    }
    var liste = el('ul');
    Object.keys(geaendert).forEach(function (k) {
      var g = geaendert[k], f = g.f;
      var neu;
      if (g.wert === null) neu = 'auf die Umgebung zurück' + (f.art === 'geheim' ? '' : ' (' + wertText(f, f.umgebungWert) + ')');
      else if (f.art === 'geheim') neu = g.entfernen ? 'wird entfernt' : 'neuer Wert';
      else neu = wertText(f, rohFuerServer(g));
      liste.appendChild(el('li', null, el('strong', { text: f.label + ': ' }), el('span', { class: 'alt', text: wertText(f, f.art === 'geheim' ? (f.gesetzt ? 'x' : '') : f.wert) }), ' → ', el('span', { text: neu })));
    });
    var dlg = el('dialog', { 'aria-labelledby': 'dlg_t' },
      el('h2', { id: 'dlg_t', text: anzahl() === 1 ? 'Diese Änderung speichern?' : 'Diese ' + anzahl() + ' Änderungen speichern?' }),
      liste,
      el('div', { class: 'zeile', style: 'justify-content:flex-end' },
        el('button', { type: 'button', text: 'Abbrechen', onclick: function () { dlg.close(); } }),
        el('button', { type: 'button', class: 'primary', text: 'Speichern', onclick: function () { dlg.close(); speichern(); } })));
    dlg.addEventListener('close', function () { dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  function speichern() {
    var aenderungen = Object.keys(geaendert).map(function (k) { return { key: k, wert: rohFuerServer(geaendert[k]) }; });
    if (aenderungen.length === 0) return;
    api('PUT', '/settings/api/values', { aenderungen: aenderungen }).then(function (r) {
      if (r.status === 200) { geaendert = {}; ungueltig = {}; serverFehler = {}; entwurf = null; ladeNeu(r.body.geaendert.length ? 'Gespeichert.' : 'Nichts geändert — die Werte standen schon so.'); }
      else if (r.status === 422) {
        serverFehler = r.body.fehler || {};
        neuZeichnen();
        var fk = ersterFehler();
        if (fk && zuGruppe(fk)) zeigeTab(zuGruppe(fk));
        zeigeMeldung(r.body.message || 'Bitte die Felder prüfen.', true);
      } else if (r.status !== 401) zeigeMeldung(r.body.message || 'Speichern fehlgeschlagen.', true);
    });
  }

  function verwerfen() {
    geaendert = {}; ungueltig = {}; serverFehler = {}; entwurf = null;
    neuZeichnen();
    zeigeMeldung('Änderungen verworfen.', false);
  }

  function ladeNeu(text) {
    api('GET', '/settings/api/state').then(function (r) {
      if (r.status !== 200) return;
      state = r.body; csrf = state.csrf;
      protokollDaten = { zeilen: state.protokoll, anzahl: state.protokollAnzahl, offset: 0, seite: state.protokoll.length || 30 };
      protokollFilter = '';
      neuZeichnen();
      zeigeMeldung(text, false);
    });
  }

  // ---------------------------------------------------------------- Zustand

  function vergleichsStand(s) { return (s.letzterErfolg || '') + '|' + s.fehlerInFolge + '|' + (s.letzterFehler || ''); }

  function abrufen(knopf) {
    var vorher = vergleichsStand(state.status);
    knopf.disabled = true; knopf.textContent = 'Abruf läuft …';
    api('POST', '/settings/api/sync').then(function (r) {
      if (!(r.status === 200 && r.body.angestossen)) { knopf.disabled = false; knopf.textContent = 'Jetzt abrufen'; zeigeMeldung('Abruf nicht möglich.', true); return; }
      var bis = Date.now() + 120000;
      (function warten() {
        api('GET', '/settings/api/state', undefined, true).then(function (s) {
          if (s.status !== 200) return;
          if (vergleichsStand(s.body.status) !== vorher) {
            uebernimmStatus(s.body);
            var st = state.status;
            zeigeMeldung(st.fehlerInFolge === 0 ? 'Abruf fertig: erfolgreich (' + zeit(st.letzterErfolg) + ').' : 'Abruf gescheitert: ' + (st.letzterFehler || 'unbekannter Fehler') + '.', st.fehlerInFolge !== 0);
          } else if (Date.now() < bis) setTimeout(warten, 3000);
          else { knopf.disabled = false; knopf.textContent = 'Jetzt abrufen'; zeigeMeldung('Der Abruf läuft noch — der Zustand aktualisiert sich von selbst.', false); }
        });
      })();
    });
  }

  function uebernimmStatus(neu) {
    state.status = neu.status; state.geheimnisse = neu.geheimnisse; state.sitzung = neu.sitzung;
    if (refs.panels && refs.panels.status) {
      refs.panels.status.textContent = '';
      refs.panels.status.appendChild(statusSeite());
    }
  }

  setInterval(function () {
    if (!state || aktiv !== 'status' || document.visibilityState !== 'visible') return;
    api('GET', '/settings/api/state', undefined, true).then(function (r) { if (r.status === 200 && state) uebernimmStatus(r.body); });
  }, 30000);

  function protokollWert(f, roh) {
    if (roh === null || roh === undefined) return '';
    if (!f) return roh;
    var t = f.art === 'schalter' ? schalterText(roh) : anzeigeWert(f, roh) + (f.einheit && roh !== '' && roh !== '●●●' ? ' ' + f.einheit : '');
    return t === '' ? '(leer)' : t;
  }

  function kurzwert(text) {
    if (text.length <= 60) return el('span', { text: text });
    return el('details', { class: 'mehr' }, el('summary', { text: text.slice(0, 57) + ' …' }), el('span', { text: text }));
  }

  function wiederherstellen(p) {
    var f = feldVon(p.key);
    if (!f || f.art === 'geheim') return;
    var wert;
    if (p.old_value === null) {
      if (f.quelle !== 'seite') { zeigeMeldung('Steht schon so: der Wert kommt aus der Umgebung.', false); return; }
      wert = null;
    } else wert = f.art === 'schalter' || f.versteckt || f.zeilen ? p.old_value : anzeigeWert(f, p.old_value);
    geaendert[f.key] = { f: f, wert: wert };
    if (MANNSCHAFT_KEYS.indexOf(f.key) >= 0) entwurf = null;
    setzeFehler(f.key, '');
    neuZeichnen();
    zeigeTab(f.gruppe);
    var box = document.querySelector('.feld[data-key="' + (f.versteckt ? 'TEAM_IDS' : f.key) + '"]');
    if (box) box.scrollIntoView({ block: 'center' });
    zeigeMeldung(f.label + ': alter Wert vorgemerkt — noch nicht gespeichert.', false);
  }

  function protokollTabelle() {
    var behaelter = el('div');
    var filter = el('select', { 'aria-label': 'Protokoll nach Einstellung filtern' }, el('option', { value: '', text: 'Alle Einstellungen' }));
    state.felder.forEach(function (f) { filter.appendChild(el('option', { value: f.key, text: f.label })); });
    filter.value = protokollFilter;
    var tabelleBox = el('div');
    function holen(offset) {
      api('GET', '/settings/api/protokoll?offset=' + offset + (protokollFilter ? '&key=' + encodeURIComponent(protokollFilter) : '')).then(function (r) {
        if (r.status !== 200) return;
        protokollDaten = r.body;
        zeichneTabelle();
      });
    }
    filter.addEventListener('change', function () { protokollFilter = filter.value; holen(0); });
    function zeichneTabelle() {
      tabelleBox.textContent = '';
      var d = protokollDaten;
      if (!d.zeilen.length) { tabelleBox.appendChild(el('p', { class: 'hint', text: 'Noch keine Änderungen.' })); return; }
      var prot = el('table');
      prot.appendChild(el('tr', null, el('th', { text: 'Zeit' }), el('th', { text: 'Von' }), el('th', { text: 'Einstellung' }), el('th', { text: 'Änderung' }), el('th', null, el('span', { class: 'hint', text: 'Aktion' }))));
      d.zeilen.forEach(function (p) {
        var f = feldVon(p.key);
        var aenderung = p.action === 'reset'
          ? el('span', null, el('span', { class: 'alt', text: protokollWert(f, p.old_value) }), ' → auf die Umgebung zurückgesetzt')
          : el('span', null, p.old_value === null ? null : el('span', { class: 'alt' }, kurzwert(protokollWert(f, p.old_value))), p.old_value === null ? '' : ' → ', kurzwert(protokollWert(f, p.new_value)));
        var knopf = f && f.art !== 'geheim'
          ? el('button', { type: 'button', text: 'Alten Wert', title: 'Den Wert vor dieser Änderung wiederherstellen', 'aria-label': 'Wert vor dieser Änderung von ' + f.label + ' wiederherstellen', onclick: function () { wiederherstellen(p); } })
          : null;
        prot.appendChild(el('tr', null, el('td', { text: zeit(p.at) }), el('td', { text: p.actor }), el('td', { text: f ? f.label : p.key }), el('td', null, aenderung), el('td', null, knopf)));
      });
      tabelleBox.appendChild(prot);
      var bis = Math.min(d.offset + d.zeilen.length, d.anzahl);
      tabelleBox.appendChild(el('div', { class: 'bar', style: 'margin-top:8px' },
        el('span', { class: 'hint', text: (d.offset + 1) + '–' + bis + ' von ' + d.anzahl }),
        el('span', { class: 'zeile' },
          el('button', { type: 'button', text: '← Neuere', disabled: d.offset === 0 ? 'disabled' : null, onclick: function () { holen(Math.max(0, d.offset - d.seite)); } }),
          el('button', { type: 'button', text: 'Ältere →', disabled: bis >= d.anzahl ? 'disabled' : null, onclick: function () { holen(d.offset + d.seite); } }))));
    }
    zeichneTabelle();
    behaelter.appendChild(el('p', null, filter));
    behaelter.appendChild(tabelleBox);
    return behaelter;
  }

  function checklisteKarte() {
    var liste = el('ul', { class: 'check' });
    var punkte = state.checkliste.slice();
    if (saisonStand && !saisonStand.fehler && saisonStand.teams.length) {
      var schlecht = saisonStand.teams.filter(function (t) { return !t.ok; }).length;
      punkte.splice(1, 0, { key: 'saison', ok: schlecht === 0, pflicht: true, tab: 'mannschaften', text: schlecht === 0 ? 'Alle Mannschaften haben Spiele in der ' + saisonText(saisonStand.saison) : schlecht + ' Mannschaft(en) ohne Spiele in der ' + saisonText(saisonStand.saison) + ' — Saisonwechsel?' });
    }
    punkte.forEach(function (p) {
      var ziel = p.key === 'saison' ? 'mannschaften' : p.tab;
      var knopf = p.ok || ziel === 'status' ? null : el('button', { type: 'button', text: 'Beheben', onclick: function () {
        zeigeTab(ziel);
        var anker = p.key === 'saison' || p.key === 'vereine' ? document.getElementById('saisonwechsel') : null;
        if (anker) anker.scrollIntoView({ block: 'start' }); else window.scrollTo(0, 0);
      } });
      liste.appendChild(el('li', null,
        el('span', { class: 'zeichen ' + (p.ok ? 'ok' : p.pflicht ? 'err' : 'warn'), 'aria-hidden': 'true', text: p.ok ? '✓' : p.pflicht ? '✕' : '!' }),
        el('span', { class: 'text' }, p.text, p.ok || p.pflicht ? null : el('span', { class: 'hint', text: ' (empfohlen)' })), knopf));
    });
    return el('div', { class: 'card' }, el('h2', { text: 'Einrichtung' }), liste);
  }

  function umgebungKarte() {
    var box = el('div', { class: 'card' }, el('h2', { text: 'Umgebung (.env)' }));
    if (state.umgebung.length) {
      box.appendChild(el('p', { class: 'hint', text: 'Diese Einstellungen kommen noch aus der Umgebung des Containers. Übernommen stehen sie hier und lassen sich ohne Neustart ändern; danach können sie aus der .env gelöscht werden.' }));
      box.appendChild(el('ul', null, state.umgebung.map(function (u) { return el('li', { text: u.label + ' (' + u.key + ')' }); }).reduce(function (a, b) { a.appendChild(b); return a; }, document.createDocumentFragment())));
      var knopf = el('button', { type: 'button', class: 'primary', text: 'Auf diese Seite übernehmen' });
      knopf.addEventListener('click', function () {
        if (anzahl() > 0) { zeigeMeldung('Erst die offenen Änderungen speichern oder verwerfen.', true); return; }
        knopf.disabled = true;
        api('POST', '/settings/api/uebernehmen').then(function (r) {
          if (r.status !== 200) { knopf.disabled = false; zeigeMeldung(r.body.message || 'Übernahme gescheitert.', true); return; }
          var abgelehnt = Object.keys(r.body.fehler || {});
          ladeNeu(r.body.geaendert.length + ' Einstellung(en) übernommen.' + (abgelehnt.length ? ' Nicht übernommen (Wert ungültig): ' + abgelehnt.join(', ') + '.' : ''));
        });
      });
      box.appendChild(el('p', null, knopf));
    } else {
      box.appendChild(el('p', { class: 'hint ok', text: 'Alle Einstellungen dieser Seite liegen in der Datenbank. In der .env braucht es nur noch Adresse, Anschlüsse und das Passwort dieser Seite.' }));
    }
    var geh = el('table');
    state.geheimnisse.forEach(function (g) {
      geh.appendChild(el('tr', null, el('th', { text: g.label }), el('td', { text: g.gesetzt ? 'gesetzt, ' + g.herkunft : 'noch nicht erzeugt', class: g.gesetzt ? null : 'hint' }), el('td', { class: 'hint', text: g.hinweis })));
    });
    box.appendChild(geh);
    return box;
  }

  function statusSeite() {
    var s = state.status;
    if (!saisonGeholt && state.status.mannschaften > 0) saisonHolen(function () { if (state && refs.panels && refs.panels.status) { refs.panels.status.textContent = ''; refs.panels.status.appendChild(statusSeite()); } });
    var tab = el('table');
    function z(a, b, klasse) { tab.appendChild(el('tr', null, el('th', { text: a }), el('td', { text: b, class: klasse || null }))); }
    z('Mannschaften', String(s.mannschaften));
    z('Letzter erfolgreicher Abruf', zeit(s.letzterErfolg));
    z('Fehlversuche in Folge', String(s.fehlerInFolge), s.fehlerInFolge ? 'warn' : null);
    if (s.letzterFehler) z('Letzter Fehler', s.letzterFehler, 'warn');
    z('Bot', s.bot.an ? ('an' + (s.bot.name ? ' (@' + s.bot.name + ')' : '') + ', ' + s.bot.abonnenten + ' Abonnenten') : 'aus (kein Token)');
    if (s.bot.webhook) z('Webhook', s.bot.webhook.ok ? 'in Ordnung (' + zeit(s.bot.webhook.at) + ')' : 'Fehler: ' + s.bot.webhook.error, s.bot.webhook.ok ? null : 'warn');
    z('Browser-Anmeldungen', String(s.push));
    var knopf = el('button', { type: 'button', text: 'Jetzt abrufen' });
    knopf.addEventListener('click', function () { abrufen(knopf); });
    var sz = state.sitzung;
    return el('div', null,
      checklisteKarte(),
      el('div', { class: 'card' }, el('h2', { text: 'Zustand' }), tab,
        el('p', { class: 'hint', text: 'Aktualisiert sich alle 30 Sekunden, solange dieser Tab offen ist.' }),
        el('p', null, knopf)),
      umgebungKarte(),
      el('div', { class: 'card' }, el('h2', { text: 'Sitzung' }),
        el('p', { class: 'hint', text: 'Angemeldet bis spätestens ' + zeit(sz.bis, true) + ' Uhr; nach ' + sz.leerlaufMin + ' Minuten ohne Zutun früher (zurzeit ' + zeit(sz.leerlaufBis, true) + ' Uhr).' }),
        el('p', null, el('button', { type: 'button', text: 'Überall abmelden', onclick: function () {
          if (!window.confirm('Alle Sitzungen beenden, auch diese?')) return;
          api('POST', '/settings/api/logout-all').then(function () { geaendert = {}; login('Überall abgemeldet.'); });
        } }))),
      el('div', { class: 'card' }, el('h2', { text: 'Protokoll der Änderungen' }), protokollTabelle()));
  }

  // ---------------------------------------------------------------- Seite

  function neuZeichnen() {
    var y = window.scrollY;
    zeichne();
    window.scrollTo(0, y);
  }

  function zeichne() {
    app.textContent = '';
    fehlerZiele = {};
    nachMannschaften = [];
    farbenAktualisieren = null;
    editorAktualisieren = null;
    refs = { tabs: {}, panels: {}, zahlen: {} };
    var tabs = el('nav', { role: 'tablist', 'aria-label': 'Bereiche der Einstellungen' });
    var gruppen = reihe();
    gruppen.forEach(function (g, i) {
      var zahl = el('span', { class: 'zahl', 'aria-hidden': 'true' });
      zahl.hidden = true;
      refs.zahlen[g] = zahl;
      var t = el('button', { type: 'button', role: 'tab', id: 'tab_' + g, 'aria-controls': 'panel_' + g, 'aria-selected': 'false', tabindex: '-1', onclick: function () { zeigeTab(g); } }, tabName(g), zahl);
      t.addEventListener('keydown', function (ev) {
        var j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: gruppen.length - 1 }[ev.key];
        if (j === undefined) return;
        ev.preventDefault();
        zeigeTab(gruppen[(j + gruppen.length) % gruppen.length], true);
      });
      refs.tabs[g] = t;
      tabs.appendChild(t);
    });
    refs.meldung = el('div', { class: 'meldung', role: 'status', 'aria-live': 'polite' });
    refs.meldung.hidden = true;
    app.appendChild(el('div', { class: 'bar' },
      el('div', null, el('h1', { text: 'Handballteck · Einstellungen' }),
        el('div', { class: 'hint', text: 'Angemeldet als ' + state.user + (state.eigenerAnschluss ? ' · eigener Anschluss' : '') })),
      el('div', { class: 'zeile' },
        state.vorschau ? el('a', { class: 'btn', href: '/settings/vorschau', target: '_blank', rel: 'noopener noreferrer', text: 'Vorschau öffnen' }) : null,
        el('a', { class: 'btn', href: '/settings/api/export', download: 'handballteck.env', text: 'Als .env exportieren' }),
        el('button', { type: 'button', text: 'Abmelden', onclick: function () {
          if (anzahl() > 0 && !window.confirm('Es gibt ungespeicherte Änderungen. Trotzdem abmelden?')) return;
          api('POST', '/settings/api/logout').then(function () { geaendert = {}; login(); });
        } }))));
    app.appendChild(tabs);
    app.appendChild(refs.meldung);
    gruppen.forEach(function (g) {
      var panel = el('div', { role: 'tabpanel', id: 'panel_' + g, 'aria-labelledby': 'tab_' + g });
      if (g === 'status') panel.appendChild(statusSeite());
      else {
        var karte = el('div', { class: 'card' }, el('h2', { text: state.gruppen[g] }));
        state.felder.filter(function (f) { return f.gruppe === g && !f.versteckt; }).forEach(function (f) { karte.appendChild(feldZeile(f)); });
        if (g === 'aussehen') karte.appendChild(farbVorschau());
        if (g === 'telegram') karte.appendChild(telegramZusatz());
        if (g === 'microsite') { karte.appendChild(einbettenZusatz()); karte.appendChild(micrositeZusatz()); }
        if (g === 'fortgeschritten') karte.insertBefore(fortgeschrittenHinweis(), karte.children[1] || null);
        panel.appendChild(karte);
        if (g === 'mannschaften') panel.appendChild(saisonAssistent());
      }
      refs.panels[g] = panel;
      app.appendChild(panel);
    });
    refs.leisteText = el('span', { role: 'status' });
    refs.leiste = el('div', { class: 'leiste' }, el('div', null, refs.leisteText,
      el('span', { class: 'zeile' },
        el('button', { type: 'button', text: 'Verwerfen', onclick: function () { if (window.confirm('Alle ungespeicherten Änderungen verwerfen?')) verwerfen(); } }),
        el('button', { type: 'button', class: 'primary', text: 'Speichern …', title: 'Strg+S', 'aria-keyshortcuts': 'Control+S', onclick: oeffneDialog }))));
    app.appendChild(refs.leiste);
    zeigeTab(aktiv);
    aktualisiereZaehler();
  }

  laden();
})();
`;

/** Service Worker nur für den Test-Push der Einstellungsseite: zeigt die Nachricht, mehr nicht. */
export const SETTINGS_SW = String.raw`self.addEventListener('push', function (ev) {
  var d = {};
  try { d = ev.data ? ev.data.json() : {}; } catch (e) { d = {}; }
  ev.waitUntil(self.registration.showNotification(d.title || 'Handballteck', { body: d.body || '', tag: d.tag || 'settings-test' }));
});
`;
