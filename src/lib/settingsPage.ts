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
button.active{border-color:var(--accent);box-shadow:inset 0 -3px 0 var(--accent)}
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
.mrow{display:grid;grid-template-columns:110px 1fr 1fr auto auto;gap:8px;align-items:center;margin-bottom:8px}
.mrow.kopf{font-size:.8rem;font-weight:600;color:var(--muted);margin-bottom:4px}
.mrow .fotos{display:flex;flex-direction:column;gap:2px;font-size:.85rem;font-weight:400;white-space:nowrap}
.mrow .fotos label{display:flex;align-items:center;gap:6px;margin:0;font-weight:400;min-height:20px}
.mrow .fotos input{width:auto;margin:0}
.mrow .knoepfe{display:flex;gap:4px}
.mrow .knoepfe button{padding:4px 10px;min-height:40px}
@media (max-width:720px){.mrow{grid-template-columns:1fr 1fr}.mrow .fotos,.mrow .knoepfe{grid-column:1/-1}.mrow.kopf{display:none}.mrow{padding-bottom:10px;border-bottom:1px solid var(--line)}}
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
  var geaendert = {};

  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function api(method, pfad, body) {
    var opt = { method: method, credentials: 'same-origin', headers: {} };
    if (csrf) opt.headers['X-CSRF-Token'] = csrf;
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(pfad, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; });
    });
  }

  function zeit(iso) {
    if (!iso) return '–';
    var d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString('de-DE');
  }

  function login(meldung) {
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
      state = r.body; csrf = state.csrf; zeichne();
    });
  }

  function feldWert(f) {
    if (f.faktor && f.wert !== '' && !isNaN(Number(f.wert))) return String(Number(f.wert) / f.faktor);
    return f.wert;
  }

  function zuRohwert(f, anzeige) {
    if (f.faktor && anzeige.trim() !== '' && !isNaN(Number(anzeige.replace(',', '.')))) return String(Math.round(Number(anzeige.replace(',', '.')) * f.faktor));
    return anzeige;
  }

  // Mannschaften: je Zeile Team-ID und Anzeigename; gespeichert wird weiter 'id=Name,id' (siehe TEAM_IDS).
  var ungueltig = {};
  function mannschaftenLesen(roh) {
    var out = [];
    String(roh || '').split(/[,;\n]+/).forEach(function (teil) {
      var t = teil.trim();
      if (!t) return;
      var i = t.indexOf('=');
      if (i >= 0) out.push({ id: t.slice(0, i).trim(), name: t.slice(i + 1).trim(), slug: '', gruppe: false, spieler: false });
      else t.split(/\s+/).forEach(function (id) { out.push({ id: id, name: '', slug: '', gruppe: false, spieler: false }); });
    });
    return out;
  }
  function mannschaftenText(liste) {
    return liste.filter(function (m) { return m.id || m.name; }).map(function (m) { return m.name ? m.id + '=' + m.name : m.id; }).join(',');
  }
  // id=wert-Listen der versteckten Felder (ClubDesk-Seite, Fotos) als Abbildung.
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
  function feldVon(key) { return state.felder.filter(function (x) { return x.key === key; })[0] || null; }
  function mannschaftenEditor(f, ziel, fehler, geaendertMelden) {
    var liste = mannschaftenLesen(f.wert);
    var clubdeskFeld = feldVon('CLUBDESK_TEAMS');
    var fotosFeld = feldVon('SITE_PHOTOS');
    var slugs = paareLesen(clubdeskFeld ? clubdeskFeld.wert : '');
    var fotos = paareLesen(fotosFeld ? fotosFeld.wert : '');
    liste.forEach(function (m) {
      m.slug = slugs[m.id] || '';
      var rechte = (fotos[m.id] || '').toLowerCase().split('+');
      m.gruppe = rechte.indexOf('mannschaft') >= 0;
      m.spieler = rechte.indexOf('spieler') >= 0;
    });
    var startClubdesk = clubdeskText(liste), startFotos = fotosText(liste);
    if (liste.length === 0) liste.push({ id: '', name: '', slug: '', gruppe: false, spieler: false });
    var behaelter = el('div');
    function pruefen() {
      var meldung = '';
      var gesehen = {};
      liste.forEach(function (m) {
        if (!m.id && !m.name) return;
        if (!/^\d{1,12}$/.test(m.id)) meldung = meldung || 'Die Team-ID besteht nur aus Ziffern, z. B. 96254.';
        else if (gesehen[m.id]) meldung = meldung || 'Die Team-ID ' + m.id + ' steht zweimal da.';
        gesehen[m.id] = true;
        if (/[,;\n]/.test(m.name) || m.name.length > 40) meldung = meldung || 'Der Name darf höchstens 40 Zeichen haben, ohne Komma und Semikolon.';
        if (m.slug && !/^[a-z0-9_-]{1,40}$/i.test(m.slug)) meldung = meldung || 'Die ClubDesk-Seite ist der letzte Teil der Adresse, z. B. woelfe_1.';
        if ((m.gruppe || m.spieler) && !m.slug) meldung = meldung || 'Fotos brauchen die ClubDesk-Seite der Mannschaft.';
      });
      if (meldung) ungueltig[f.key] = true; else delete ungueltig[f.key];
      fehler.textContent = meldung;
    }
    function neuZeichnen() {
      behaelter.textContent = '';
      behaelter.appendChild(el('div', { class: 'mrow kopf' }, el('span', { text: 'Team-ID' }), el('span', { text: 'Name (leer: von handball.net)' }), el('span', { text: 'ClubDesk-Seite' }), el('span', { text: 'Fotos öffentlich' }), el('span', { class: 'knoepfe' })));
      liste.forEach(function (m, i) {
        var idFeld = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '96254', 'aria-label': 'Team-ID, Mannschaft ' + (i + 1) });
        var nameFeld = el('input', { type: 'text', autocomplete: 'off', placeholder: 'z. B. B-Jugend', 'aria-label': 'Name, Mannschaft ' + (i + 1) });
        var slugFeld = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'z. B. woelfe_1', 'aria-label': 'ClubDesk-Seite, Mannschaft ' + (i + 1) });
        var gruppeFeld = el('input', { type: 'checkbox', 'aria-label': 'Mannschaftsbild öffentlich, Mannschaft ' + (i + 1) });
        var spielerFeld = el('input', { type: 'checkbox', 'aria-label': 'Spielerbilder öffentlich, Mannschaft ' + (i + 1) });
        idFeld.value = m.id; nameFeld.value = m.name; slugFeld.value = m.slug; gruppeFeld.checked = m.gruppe; spielerFeld.checked = m.spieler;
        idFeld.addEventListener('input', function () { m.id = idFeld.value.trim(); aenderung(); });
        nameFeld.addEventListener('input', function () { m.name = nameFeld.value.trim(); aenderung(); });
        slugFeld.addEventListener('input', function () { m.slug = slugFeld.value.trim(); aenderung(); });
        gruppeFeld.addEventListener('change', function () { m.gruppe = gruppeFeld.checked; aenderung(); });
        spielerFeld.addEventListener('change', function () {
          if (spielerFeld.checked && !window.confirm('Porträts mit Namen werden öffentlich gezeigt. Nur bei Senioren und nur, wenn die Bildrechte mit dem Verein geklärt sind. Wirklich einschalten?')) { spielerFeld.checked = false; return; }
          m.spieler = spielerFeld.checked; aenderung();
        });
        function schieben(d) {
          var j = i + d;
          if (j < 0 || j >= liste.length) return;
          var x = liste[i]; liste[i] = liste[j]; liste[j] = x;
          neuZeichnen(); aenderung();
        }
        behaelter.appendChild(el('div', { class: 'mrow' }, idFeld, nameFeld, slugFeld,
          el('span', { class: 'fotos' },
            el('label', null, gruppeFeld, 'Mannschaftsbild'),
            el('label', null, spielerFeld, 'Spielerbilder')),
          el('span', { class: 'knoepfe' },
            el('button', { type: 'button', text: '↑', 'aria-label': 'Nach oben', onclick: function () { schieben(-1); } }),
            el('button', { type: 'button', text: '↓', 'aria-label': 'Nach unten', onclick: function () { schieben(1); } }),
            el('button', { type: 'button', text: '✕', 'aria-label': 'Mannschaft entfernen', onclick: function () { liste.splice(i, 1); if (liste.length === 0) liste.push({ id: '', name: '', slug: '', gruppe: false, spieler: false }); neuZeichnen(); aenderung(); } }))));
      });
      behaelter.appendChild(el('p', null, el('button', { type: 'button', text: '+ Mannschaft hinzufügen', onclick: function () { liste.push({ id: '', name: '', slug: '', gruppe: false, spieler: false }); neuZeichnen(); } })));
    }
    // Die versteckten Felder wandern mit: geändert, sobald ihr Text vom Start abweicht.
    function nebenfeld(feld, start, text) {
      if (!feld) return;
      if (text !== start) geaendert[feld.key] = { f: feld, wert: text }; else delete geaendert[feld.key];
    }
    function aenderung() {
      pruefen();
      ziel.value = mannschaftenText(liste);
      nebenfeld(clubdeskFeld, startClubdesk, clubdeskText(liste));
      nebenfeld(fotosFeld, startFotos, fotosText(liste));
      geaendertMelden();
    }
    neuZeichnen();
    return behaelter;
  }

  function feldZeile(f) {
    var id = 'f_' + f.key;
    var eingabe;
    var start = feldWert(f);
    if (f.art === 'schalter') {
      eingabe = el('select', { id: id }, el('option', { value: 'true', text: 'an' }), el('option', { value: 'false', text: 'aus' }));
      eingabe.value = (f.wert || f.standard) === 'false' ? 'false' : 'true';
      start = eingabe.value;
    } else if (f.zeilen === 'mannschaften') {
      eingabe = el('input', { id: id, type: 'hidden' });
      start = mannschaftenText(mannschaftenLesen(f.wert));
      eingabe.value = start;
    } else if (f.lang) {
      eingabe = el('textarea', { id: id, spellcheck: 'false' });
      eingabe.value = start;
    } else if (f.art === 'geheim') {
      eingabe = el('input', { id: id, type: 'password', autocomplete: 'new-password', placeholder: f.gesetzt ? 'gesetzt — zum Ersetzen neuen Wert eingeben' : 'nicht gesetzt' });
      start = '';
    } else {
      eingabe = el('input', { id: id, type: f.faktor ? 'number' : 'text', inputmode: f.faktor ? 'numeric' : null, autocomplete: 'off', spellcheck: 'false' });
      eingabe.value = start;
    }
    var fehler = el('div', { class: 'err', role: 'alert' });
    var box = el('div', { class: 'feld' });
    var kopf = el('label', { for: id, text: f.label + (f.einheit ? ' (' + f.einheit + ')' : '') },
      el('span', { class: 'badge' + (f.quelle === 'seite' ? ' seite' : ''), text: f.quelle === 'seite' ? 'von dieser Seite' : f.quelle === 'umgebung' ? 'aus der Umgebung' : 'Standard' }));
    var zeile = el('div', { class: 'zeile' }, eingabe);
    if (f.zeilen === 'mannschaften') {
      zeile = el('div', null, eingabe, mannschaftenEditor(f, eingabe, fehler, function () { markiere(); }));
    }
    if (f.art === 'farbe') {
      var pick = el('input', { type: 'color', 'aria-label': f.label + ' wählen' });
      var vorschau = function () { if (/^#[0-9a-fA-F]{6}$/.test(eingabe.value)) pick.value = eingabe.value; else pick.value = f.standard; };
      vorschau();
      pick.addEventListener('input', function () { eingabe.value = pick.value; markiere(); });
      eingabe.addEventListener('input', vorschau);
      zeile.appendChild(pick);
    }
    if (f.art === 'geheim') {
      zeile.appendChild(el('button', { type: 'button', text: 'Erzeugen', onclick: function () {
        var b = new Uint8Array(24); crypto.getRandomValues(b);
        eingabe.value = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
        eingabe.type = 'text'; markiere();
      } }));
      if (f.gesetzt) zeile.appendChild(el('button', { type: 'button', text: 'Entfernen', onclick: function () { eingabe.dataset.entfernen = '1'; eingabe.value = ''; eingabe.placeholder = 'wird beim Speichern entfernt'; markiere(); } }));
    }
    function markiere() {
      var neu = eingabe.dataset.entfernen === '1' ? '' : eingabe.value;
      if (eingabe.dataset.entfernen === '1' || neu !== start) geaendert[f.key] = { f: f, wert: neu }; else delete geaendert[f.key];
      statusKnopf();
    }
    eingabe.addEventListener('input', function () { if (eingabe.dataset.entfernen) delete eingabe.dataset.entfernen; markiere(); });
    eingabe.addEventListener('change', markiere);
    box.appendChild(kopf); box.appendChild(zeile);
    box.appendChild(el('p', { class: 'hint', text: f.hinweis + (f.standard ? ' Standard: ' + (f.faktor ? Number(f.standard) / f.faktor : f.standard) + '.' : '') }));
    var wirk = { 'sofort': 'Wirkt sofort.', 'abruf': 'Wirkt beim nächsten Abruf (wird beim Speichern angestoßen).', 'naechster-takt': 'Wirkt ab dem nächsten Takt.' }[f.wirkung];
    box.appendChild(el('p', { class: 'hint', text: wirk }));
    if (f.quelle === 'seite' && f.art !== 'geheim') {
      box.appendChild(el('p', { class: 'hint' },
        'Die Umgebung sagt: ' + (f.umgebungWert === '' ? '(nichts)' : f.umgebungWert) + '. ',
        el('button', { type: 'button', text: 'Auf die Umgebung zurücksetzen', onclick: function () {
          speichern([{ key: f.key, wert: null }]);
        } })));
    } else if (f.quelle === 'seite') {
      box.appendChild(el('p', { class: 'hint' }, el('button', { type: 'button', text: 'Auf die Umgebung zurücksetzen', onclick: function () { speichern([{ key: f.key, wert: null }]); } })));
    }
    box.appendChild(fehler);
    box._fehler = fehler; box._key = f.key;
    return box;
  }

  var speicherKnopf, meldung;
  function statusKnopf() { if (speicherKnopf) speicherKnopf.disabled = Object.keys(geaendert).length === 0; }

  function speichern(liste) {
    var aenderungen = liste || Object.keys(geaendert).map(function (k) {
      var g = geaendert[k];
      return { key: k, wert: g.f.art === 'schalter' ? g.wert : zuRohwert(g.f, g.wert) };
    });
    if (aenderungen.length === 0) return;
    if (!liste && Object.keys(ungueltig).length > 0) { zeigeMeldung('Bitte die markierten Mannschaften korrigieren.', true); return; }
    var teuer = aenderungen.some(function (a) { return a.key === 'SITE_PLAYERS' && a.wert === 'true'; });
    if (teuer && !window.confirm('Spielernamen werden öffentlich gezeigt — bei Jugendmannschaften auch Namen von Kindern. Wirklich einschalten?')) return;
    api('PUT', '/settings/api/values', { aenderungen: aenderungen }).then(function (r) {
      if (r.status === 200) { geaendert = {}; ungueltig = {}; ladeNeu('Gespeichert.'); }
      else if (r.status === 422) {
        document.querySelectorAll('.feld').forEach(function (b) {
          var m = r.body.fehler && r.body.fehler[b._key];
          b._fehler.textContent = m || '';
          b.classList.toggle('fehlerfeld', Boolean(m));
        });
        zeigeMeldung(r.body.message || 'Bitte die Felder prüfen.', true);
      } else if (r.status === 401) login('Die Sitzung ist abgelaufen.');
      else zeigeMeldung(r.body.message || 'Speichern fehlgeschlagen.', true);
    });
  }

  function ladeNeu(text) {
    api('GET', '/settings/api/state').then(function (r) {
      if (r.status === 200) { state = r.body; csrf = state.csrf; zeichne(); zeigeMeldung(text, false); }
    });
  }

  function zeigeMeldung(text, fehler) {
    if (!meldung) return;
    meldung.textContent = text;
    meldung.className = 'meldung ' + (fehler ? 'err' : 'ok');
  }

  function statusSeite() {
    var s = state.status;
    var tab = el('table');
    function z(a, b) { tab.appendChild(el('tr', null, el('th', { text: a }), el('td', { text: b }))); }
    z('Mannschaften', String(s.mannschaften));
    z('Letzter erfolgreicher Abruf', zeit(s.letzterErfolg));
    z('Fehlversuche in Folge', String(s.fehlerInFolge));
    if (s.letzterFehler) z('Letzter Fehler', s.letzterFehler);
    z('Bot', s.bot.an ? ('an' + (s.bot.name ? ' (@' + s.bot.name + ')' : '') + ', ' + s.bot.abonnenten + ' Abonnenten') : 'aus (kein Token)');
    if (s.bot.webhook) z('Webhook', s.bot.webhook.ok ? 'in Ordnung (' + zeit(s.bot.webhook.at) + ')' : 'Fehler: ' + s.bot.webhook.error);
    z('Browser-Anmeldungen', String(s.push));
    var geh = el('table');
    state.geheimnisse.forEach(function (g) {
      geh.appendChild(el('tr', null, el('th', { text: g.label }), el('td', { text: g.gesetzt ? 'gesetzt' : 'nicht gesetzt' }), el('td', { class: 'hint', text: g.hinweis })));
    });
    var prot = el('table');
    prot.appendChild(el('tr', null, el('th', { text: 'Zeit' }), el('th', { text: 'Von' }), el('th', { text: 'Einstellung' }), el('th', { text: 'Änderung' })));
    state.protokoll.forEach(function (p) {
      prot.appendChild(el('tr', null, el('td', { text: zeit(p.at) }), el('td', { text: p.actor }), el('td', { text: p.key }),
        el('td', { text: p.action === 'reset' ? 'auf Umgebung zurückgesetzt' : (p.old_value === null ? '' : p.old_value) + ' → ' + p.new_value })));
    });
    return el('div', null,
      el('div', { class: 'card' }, el('h2', { text: 'Zustand' }), tab,
        el('p', null, el('button', { type: 'button', text: 'Jetzt abrufen', onclick: function () {
          api('POST', '/settings/api/sync').then(function (r) { zeigeMeldung(r.status === 200 && r.body.angestossen ? 'Abruf angestoßen.' : 'Abruf nicht möglich.', !(r.status === 200 && r.body.angestossen)); });
        } }))),
      el('div', { class: 'card' }, el('h2', { text: 'Nur in der Umgebung' }), geh),
      el('div', { class: 'card' }, el('h2', { text: 'Protokoll der Änderungen' }), state.protokoll.length ? prot : el('p', { class: 'hint', text: 'Noch keine Änderungen.' })));
  }

  function zeichne() {
    app.textContent = '';
    var tabs = el('nav', { role: 'tablist' });
    var reihe = ['status'].concat(Object.keys(state.gruppen));
    reihe.forEach(function (g) {
      tabs.appendChild(el('button', { type: 'button', class: g === aktiv ? 'active' : '', text: g === 'status' ? 'Zustand' : state.gruppen[g], onclick: function () { aktiv = g; zeichne(); } }));
    });
    meldung = el('div', { class: 'meldung hidden', role: 'status' });
    app.appendChild(el('div', { class: 'bar' },
      el('div', null, el('h1', { text: 'Handballteck · Einstellungen' }),
        el('div', { class: 'hint', text: 'Angemeldet als ' + state.user + (state.eigenerAnschluss ? ' · eigener Anschluss' : '') })),
      el('div', { class: 'zeile' },
        state.vorschau ? el('a', { class: 'btn', href: '/settings/vorschau', target: '_blank', rel: 'noopener noreferrer', text: 'Vorschau öffnen' }) : null,
        el('a', { class: 'btn', href: '/settings/api/export', download: 'handballteck.env', text: 'Als .env exportieren' }),
        el('button', { type: 'button', text: 'Abmelden', onclick: function () { api('POST', '/settings/api/logout').then(function () { csrf = ''; login(); }); } }))));
    app.appendChild(tabs);
    app.appendChild(meldung);
    if (aktiv === 'status') { app.appendChild(statusSeite()); return; }
    var karte = el('div', { class: 'card' }, el('h2', { text: state.gruppen[aktiv] }));
    state.felder.filter(function (f) { return f.gruppe === aktiv && !f.versteckt; }).forEach(function (f) { karte.appendChild(feldZeile(f)); });
    speicherKnopf = el('button', { class: 'primary', type: 'button', text: 'Speichern', disabled: 'disabled', onclick: function () { speichern(); } });
    karte.appendChild(el('p', null, speicherKnopf));
    app.appendChild(karte);
    statusKnopf();
  }

  laden();
})();
`;
