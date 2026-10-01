/**
 * Stile, Service Worker und Skript der Microsite — als eigene Routen
 * (`site.css`, `sw.js`, `app.js`) ausgeliefert, nicht in die Seite gelegt:
 * Die Seite wird kleiner, und Stile und Skript tragen einen Hash im Namen
 * (`?v=…`), der sie dauerhaft zwischenspeicherbar macht.
 */
import { createHash } from 'node:crypto';
import type { FullPalette } from './handballTableImage';

/** Kurzer Inhaltshash für `?v=` und ETag. */
export function inhaltsHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 10);
}

/**
 * Das dunkle Schema — zweimal ausgegeben: einmal für „automatisch" (folgt dem
 * Gerät, außer der Schalter steht auf hell), einmal für „dunkel" von Hand.
 * Eine Quelle, damit beide nie auseinanderlaufen.
 */
const DUNKEL: Array<[string, string]> = [
  ['', '--bg:#0c1a1f;--card:#12262c;--text:#e6f0f2;--muted:#9bb0b6;--line:#1f3840;color-scheme:dark'],
  ['.btn', 'background:#12262c;color:#e6f0f2'],
  ['.plan .e', 'background:#0c1a1f;color:#e6f0f2'],
  ['tr.own td', 'background:color-mix(in srgb,var(--a) 22%,#12262c)'],
  ['.plan li.next', 'background:color-mix(in srgb,var(--a) 14%,#12262c)'],
  ['.plan .e.w', 'background:color-mix(in srgb,var(--win) 24%,#12262c)'],
  ['.plan .e.l', 'background:color-mix(in srgb,var(--loss) 22%,#12262c)'],
];

function dunkel(): string {
  const regeln = (wurzel: string) => DUNKEL.map(([sel, body]) => `${wurzel}${sel ? ` ${sel}` : ''}{${body}}`).join('');
  return `:root{color-scheme:light dark}:root[data-theme=light]{color-scheme:light}
@media (prefers-color-scheme:dark){${regeln(':root:not([data-theme=light])')}}
${regeln(':root[data-theme=dark]')}`;
}

export function siteCss(p: FullPalette): string {
  const grund = p.primary.toLowerCase() === '#003e51' ? '#001f2b' : p.primary;
  return `
:root{--p:${p.primary};--s:${p.secondary};--a:${p.accent};--ad:${p.accentDark};--g:${grund};--bg:#f2f6f7;--card:#ffffff;--text:#10262c;--muted:#5d7178;--line:#dde6e9;--win:#1f9d55;--loss:#c9403a;--draw:#7a8a90}
@font-face{font-family:'Barlow Condensed';font-weight:700;font-display:swap;src:url(./fonts/BarlowCondensed-Bold.ttf) format('truetype')}
@font-face{font-family:'Barlow Condensed';font-weight:600;font-display:swap;src:url(./fonts/BarlowCondensed-SemiBold.ttf) format('truetype')}
@font-face{font-family:'Barlow';font-weight:400;font-display:swap;src:url(./fonts/Barlow-Regular.ttf) format('truetype')}
@font-face{font-family:'Barlow';font-weight:500;font-display:swap;src:url(./fonts/Barlow-Medium.ttf) format('truetype')}
@font-face{font-family:'Barlow';font-weight:600;font-display:swap;src:url(./fonts/Barlow-SemiBold.ttf) format('truetype')}
*{box-sizing:border-box}
[hidden]{display:none !important}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 'Barlow',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
a{color:var(--ad)}
h1,h2,h3{font-family:'Barlow Condensed','Barlow',system-ui,sans-serif;letter-spacing:.01em;margin:0}
h2{font-size:1.5rem;font-weight:700;text-transform:uppercase;color:var(--p);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.wrap{max-width:1180px;margin:0 auto;padding:0 16px 48px}
.hero{background:linear-gradient(135deg,var(--g) 0%,var(--p) 45%,var(--s) 100%);color:#fff;position:relative;overflow:hidden}
.hero::before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(-55deg,rgba(255,255,255,.035) 0 2px,transparent 2px 14px);pointer-events:none}
.hero::after{content:"";position:absolute;right:-120px;top:-120px;width:420px;height:420px;border-radius:50%;border:38px solid rgba(255,255,255,.05);pointer-events:none}
.hero .wrap{position:relative;padding-top:28px;padding-bottom:24px;display:grid;grid-template-columns:auto minmax(0,1fr);gap:16px 20px;align-items:center}
.hero img.logo{width:96px;height:96px;object-fit:contain;filter:drop-shadow(0 4px 12px rgba(0,0,0,.35))}
.hero .initialen{width:96px;height:96px;border-radius:50%;background:rgba(255,255,255,.12);display:grid;place-items:center;font-family:'Barlow Condensed',sans-serif;font-size:2.4rem;font-weight:700;color:var(--a)}
.hero h1{font-size:clamp(2rem,6vw,3.4rem);font-weight:700;line-height:1;text-transform:uppercase}
.hero .sub{margin-top:6px;color:rgba(255,255,255,.82);font-size:1rem}
.teamwahl{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.teamwahl a{padding:5px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.08);color:#fff;text-decoration:none;font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:.95rem;letter-spacing:.04em;text-transform:uppercase}
.teamwahl a:hover{background:rgba(255,255,255,.16)}
.teamwahl a[aria-current=page]{background:var(--a);border-color:var(--a);color:var(--g)}
.hero .stats{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-top:4px}
.stat{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:10px 12px;min-width:0}
.stat b{display:block;font-family:'Barlow Condensed',sans-serif;font-size:1.75rem;font-weight:700;line-height:1;color:#fff;white-space:nowrap}
.stat b.a{color:var(--a)}
.stat b small{font-size:1rem;font-weight:600;color:rgba(255,255,255,.7);margin-left:4px}
.stat span{display:block;font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.72);margin-top:5px}
.form{display:inline-flex;gap:5px;align-items:center;height:1.75rem}
.form i{display:inline-block;width:12px;height:12px;border-radius:50%;background:var(--draw)}
.form i.w{background:var(--win)}.form i.l{background:var(--loss)}
main.wrap{display:grid;gap:18px;padding-top:18px;grid-template-columns:minmax(0,1fr)}
.col{display:contents}
.s-next{order:1}.s-push{order:2}.s-last{order:3}.s-table{order:4}.s-plan{order:5}.s-season{order:6}.s-fotos{order:7}.s-team{order:8}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 1px 2px rgba(16,38,44,.04);min-width:0}
.card.dark{background:linear-gradient(135deg,var(--g),var(--p) 60%,var(--s));color:#fff;border-color:transparent}
.card.dark h2{color:var(--a)}
.card.dark a{color:#fff}
.card h2{margin-bottom:10px}
.card img.bild{display:block;width:100%;height:auto;border-radius:12px;background:#0b2a33}
.badge{display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;background:var(--a);color:var(--g);font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:.95rem;letter-spacing:.04em;text-transform:uppercase}
.badge.live{background:var(--loss);color:#fff;animation:puls 1.6s ease-in-out infinite}
@keyframes puls{50%{opacity:.6}}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:12px;border:1px solid var(--line);background:#fff;color:var(--p);font:inherit;font-weight:600;text-decoration:none;cursor:pointer;line-height:1.1}
.btn:hover{border-color:var(--ad)}
.btn.primary{background:var(--a);border-color:var(--a);color:var(--g)}
.btn.ghost{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.25);color:#fff}
.btn[disabled]{opacity:.55;cursor:default}
.muted{color:var(--muted)}
.dark .muted{color:rgba(255,255,255,.72)}
.small{font-size:.9rem}
.next .info{display:grid;gap:4px;margin-top:12px;font-size:1.05rem}
.next .info b{font-family:'Barlow Condensed',sans-serif;font-size:1.5rem;font-weight:700;text-transform:uppercase}
.result .stand{font-family:'Barlow Condensed',sans-serif;font-size:2.6rem;font-weight:700;line-height:1}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:8px 6px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-family:'Barlow Condensed',sans-serif;font-weight:600;text-transform:uppercase;font-size:.9rem;color:var(--muted);letter-spacing:.03em}
td.name,th.name{text-align:left;white-space:normal;width:100%}
tr.own td{background:color-mix(in srgb,var(--a) 14%,#fff);font-weight:600}
tr.own td:first-child{box-shadow:inset 4px 0 0 var(--a)}
td.pos{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:1.1rem;color:var(--p)}
td.pkt{font-weight:700}
.t i{font-style:normal;font-size:.75rem;margin-left:4px}
.t i.up{color:var(--win)}.t i.down{color:var(--loss)}
.legend{margin:10px 0 0;font-size:.85rem;color:var(--muted)}
.plan{list-style:none;margin:0;padding:0;display:grid}
.plan li{display:grid;grid-template-columns:96px 1fr auto;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
.plan li:last-child{border-bottom:0}
.plan .d{font-family:'Barlow Condensed',sans-serif;font-weight:600;color:var(--muted);line-height:1.1}
.plan .d small{display:block;font-weight:500}
.plan .g{min-width:0}
.plan .g .ha{color:var(--muted);font-size:.85rem}
.plan .e{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:1.35rem;padding:2px 10px;border-radius:8px;background:var(--bg);color:var(--text)}
.plan .e.w{background:color-mix(in srgb,var(--win) 16%,#fff);color:var(--win)}
.plan .e.l{background:color-mix(in srgb,var(--loss) 14%,#fff);color:var(--loss)}
.plan .e.o{color:var(--muted);font-weight:500;font-size:.95rem;background:transparent}
.plan li.next{background:color-mix(in srgb,var(--a) 10%,#fff);border-radius:10px;padding-left:8px;padding-right:8px;margin:0 -8px}
.lines{margin:0;padding-left:0;list-style:none;display:grid;gap:6px}
.lines li{padding-left:14px;position:relative}
.lines li::before{content:"";position:absolute;left:0;top:.55em;width:6px;height:6px;border-radius:50%;background:var(--a)}
.season .body{display:grid;gap:14px}
fieldset{border:0;padding:0;margin:0 0 10px}
legend{font-family:'Barlow Condensed',sans-serif;font-weight:600;text-transform:uppercase;font-size:.95rem;color:var(--a);margin-bottom:6px}
.opts{display:flex;gap:8px;flex-wrap:wrap}
.opts label{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.3);cursor:pointer;font-size:.95rem}
.opts input{accent-color:var(--a)}
.opts label:has(input:checked){background:rgba(255,255,255,.14);border-color:var(--a)}
.status{margin:6px 0 10px;font-weight:500}
.lead{margin:0 0 12px;color:rgba(255,255,255,.8)}
.channels{display:grid;gap:10px}
.channel{padding:12px 14px;border-radius:14px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#fff}
.channel[open]{border-color:rgba(255,255,255,.24)}
.channel summary{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:12px;align-items:center;cursor:pointer;list-style:none}
.channel summary::-webkit-details-marker{display:none}
.channel summary::after{content:"▾";font-size:1.1rem;color:var(--a);transition:transform .15s}
.channel[open] summary::after{transform:rotate(180deg)}
.channel .ico{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:var(--a);color:var(--g)}
.channel .ico svg{width:22px;height:22px;fill:currentColor}
.channel .ico.tg{background:#29a9eb;color:#fff}
.channel .ico.rss{background:#f28a1a;color:#fff}
.channel b{display:block;font-family:'Barlow Condensed',sans-serif;font-size:1.2rem;font-weight:700;text-transform:uppercase;letter-spacing:.02em;line-height:1.1}
.channel .body{margin-top:10px}
.channel span.desc{display:block;font-size:.9rem;color:rgba(255,255,255,.75)}
.channel a.open{display:inline-block;margin-top:8px;color:var(--a);font-weight:600;text-decoration:none}
.channel a.open:hover{text-decoration:underline}
.chip{display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;background:var(--a);color:var(--g);font-size:.7rem;letter-spacing:.06em;vertical-align:2px}
.skip{position:absolute;left:-999px;top:8px;z-index:10;padding:8px 14px;border-radius:8px;background:#fff;color:#10262c}
.skip:focus{left:8px}
.offline{padding:8px 16px;text-align:center;background:#7a4b00;color:#fff;font-size:.9rem}
:focus-visible{outline:3px solid var(--a);outline-offset:2px;border-radius:4px}
.filter{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}
.filter button{font:inherit;font-size:.9rem;padding:5px 12px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
.filter button[aria-pressed=true]{background:var(--p);border-color:var(--p);color:#fff}
.filter button.jump{margin-left:auto;border-style:dashed}
h3.unter{font-family:'Barlow Condensed',sans-serif;font-size:1.15rem;font-weight:700;text-transform:uppercase;color:var(--p);margin:12px 0 4px}
.legende{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:4px 14px;font-size:.9rem}
.legende i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
.hero .theme{position:absolute;top:12px;right:16px;z-index:2;width:40px;height:40px;border-radius:50%;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff;font-size:1.2rem;line-height:1;cursor:pointer}
.hero .theme:hover{background:rgba(255,255,255,.22)}
.vorschau-band{padding:8px 16px;text-align:center;background:#7a2a8a;color:#fff;font-size:.9rem;font-weight:600}
.portraets{list-style:none;margin:6px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:12px}
.portraets li{display:grid;gap:2px;font-size:.9rem;line-height:1.25}
.portraets img{width:100%;height:auto;aspect-ratio:4/5;object-fit:cover;border-radius:10px;background:var(--line)}
.portraets b{margin-top:4px}
.portraets span{color:var(--muted);font-size:.8rem}
.gegner{margin-top:14px;padding:12px 14px;border-radius:14px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);display:grid;gap:8px}
.gegner .kopf{display:flex;gap:12px;align-items:center}
.gegner .kopf img,.gegner .kopf .ini{width:44px;height:44px;border-radius:50%;background:#fff;object-fit:contain;flex:none}
.gegner .kopf .ini{display:grid;place-items:center;font-family:'Barlow Condensed',sans-serif;font-weight:700;color:var(--p);background:rgba(255,255,255,.85)}
.gegner .kopf b{display:block;font-family:'Barlow Condensed',sans-serif;font-size:1.15rem;font-weight:700;text-transform:uppercase;letter-spacing:.02em;line-height:1.1}
.gegner .kopf span{display:block;font-size:.9rem;color:rgba(255,255,255,.75)}
.gegner .zeile{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:.95rem}
.gegner .zeile .lbl{font-family:'Barlow Condensed',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:.8rem;color:var(--a);min-width:92px}
.gegner .form i{width:11px;height:11px}
.gegner .res{color:rgba(255,255,255,.85)}
details.more{grid-column:1/-1;margin-top:6px}
details.more summary{cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.04em;font-size:.9rem;color:var(--ad);list-style:none;display:inline-flex;align-items:center;gap:6px}
details.more summary::-webkit-details-marker{display:none}
details.more summary::before{content:"";width:0;height:0;border-left:6px solid currentColor;border-top:4px solid transparent;border-bottom:4px solid transparent;transition:transform .15s}
details.more[open] summary::before{transform:rotate(90deg)}
.verlauf{margin:10px 0 4px}
.verlauf svg{display:block;width:100%;height:auto}
.torfolge{margin:6px 0 0;font-size:.85rem;color:var(--muted);line-height:1.6}
.torfolge b{color:var(--text)}
.bericht{margin-top:10px;font-size:.98rem;line-height:1.55}
.bericht h4{font-family:'Barlow Condensed',sans-serif;font-size:1.1rem;font-weight:700;text-transform:uppercase;color:var(--p);margin:12px 0 4px}
.bericht p{margin:0 0 8px}
.bericht .quelle{font-size:.85rem;color:var(--muted)}
footer.wrap{color:var(--muted);font-size:.85rem;padding-bottom:32px;display:grid;gap:6px}
footer .betreiber{padding-top:10px;border-top:1px solid var(--line)}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation:none !important;transition:none !important}}
@media (max-width:600px){.hide-sm{display:none}.hero img.logo,.hero .initialen{width:72px;height:72px}.plan li{grid-template-columns:78px 1fr auto}}
@media (min-width:960px){
main.wrap{grid-template-columns:minmax(0,1fr) 400px;align-items:start;gap:22px;padding-top:22px}
.col{display:grid;gap:22px;min-width:0}
.hero .wrap{padding-top:36px;padding-bottom:32px;grid-template-columns:auto minmax(0,1fr) auto;gap:16px 28px}
.hero img.logo,.hero .initialen{width:120px;height:120px}
.hero .stats{grid-column:auto;grid-template-columns:repeat(3,minmax(110px,1fr));margin-top:0}
.season .body{grid-template-columns:minmax(0,3fr) minmax(0,2fr);align-items:start}
.season .body .lines{margin-top:0}
.card{padding:22px}
}
${dunkel()}
`;
}

/**
 * Setzt das gewählte Farbschema, bevor die Seite gezeichnet wird — als eigene,
 * blockierende Datei im Kopf (kein Inline-Skript, CSP), damit die Seite nicht
 * erst hell aufblitzt und dann dunkel wird.
 */
export const SITE_THEME_JS = `try { var t = localStorage.getItem('handball-site-theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (e) {}
`;

/**
 * Der Service Worker der Microsite: zeigt den Push, öffnet beim Antippen die
 * Seite — und hält die zuletzt geladene Seite samt Stil, Skript und Logo
 * für den Fall vor, dass das Netz fehlt. Die Seite kommt **immer zuerst vom
 * Server**; der Speicher springt nur ein, wenn der Abruf scheitert. Bilder,
 * `push` und alles andere gehen am Worker vorbei. Relativ zum Scope, damit
 * er auch unter einer eigenen Domain funktioniert.
 */
export const SITE_SW_JS = `/* Handball-Microsite: Push-Empfang, Offline-Rückfall für die Seite. */
var CACHE = 'handball-site-v1';
var CACHEBAR = ['site.css', 'app.js', 'theme.js', 'logo.png', 'logo-192.png', 'fonts/'];
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (namen) {
    return Promise.all(namen.filter(function (n) { return n !== CACHE; }).map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var scope = self.registration.scope;
  if (req.url.indexOf(scope) !== 0) return;
  // Die Vorschau geht nie in den Speicher — sonst stünde sie offline in der normalen Seite.
  if (req.url.indexOf('vorab=') >= 0) return;
  var rel = req.url.slice(scope.length).split('?')[0].split('#')[0];
  var seite = req.mode === 'navigate' && rel === '';
  var statisch = CACHEBAR.some(function (p) { return rel.indexOf(p) === 0; });
  if (!seite && !statisch) return;
  event.respondWith(fetch(req).then(function (res) {
    if (res && res.ok) {
      var kopie = res.clone();
      // Ältere Fassungen (anderer ?v=) vorher entfernen, sonst wächst der Speicher mit jedem Update.
      caches.open(CACHE).then(function (c) {
        var schluessel = seite ? scope : req;
        return c.delete(schluessel, { ignoreSearch: true }).then(function () { return c.put(schluessel, kopie); });
      }).catch(function () {});
    }
    return res;
  }).catch(function () {
    return caches.match(seite ? scope : req, { ignoreSearch: !seite }).then(function (hit) { return hit || Response.error(); });
  }));
});
self.addEventListener('push', function (event) {
  var payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = { title: 'Handball', body: event.data ? event.data.text() : '' }; }
  var scope = self.registration.scope;
  var options = {
    body: payload.body || '',
    icon: new URL('logo.png', scope).href,
    badge: new URL('logo.png', scope).href,
    tag: payload.tag || 'handball',
    renotify: !!payload.renotify,
    data: { url: payload.url ? new URL(payload.url, scope).href : scope }
  };
  if (payload.image) options.image = new URL(payload.image, scope).href;
  if (payload.vibrate) options.vibrate = payload.vibrate;
  event.waitUntil(self.registration.showNotification(payload.title || 'Handball', options));
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf(self.registration.scope) === 0 && 'focus' in list[i]) { list[i].navigate(url); return list[i].focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
`;

/**
 * Das Skript der Seite: prüft, ob der Browser Push kann, meldet den Service
 * Worker an, holt den VAPID-Schlüssel von `./push` und trägt die
 * Subscription mit Vorlauf und Modus ein. Ohne Push (kein VAPID, Safari
 * außerhalb des Home-Bildschirms) bleibt der Kalender.
 */
export const SITE_APP_JS = `(function () {
  // Der Service Worker gehört zur Seite, nicht nur zum Push: Er hält die
  // zuletzt geladene Fassung für den Fall ohne Netz vor.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function () {});

  // Farbschema: automatisch (Gerät) → hell → dunkel → automatisch.
  var THEME_KEY = 'handball-site-theme';
  var themeKnopf = document.querySelector('[data-theme-toggle]');
  var THEMES = { auto: ['◐', 'automatisch'], light: ['☀', 'hell'], dark: ['☾', 'dunkel'] };
  function themeZeigen(wahl) {
    if (wahl === 'light' || wahl === 'dark') document.documentElement.setAttribute('data-theme', wahl);
    else document.documentElement.removeAttribute('data-theme');
    if (!themeKnopf) return;
    var t = THEMES[wahl] || THEMES.auto;
    themeKnopf.textContent = t[0];
    themeKnopf.setAttribute('aria-label', 'Farbschema: ' + t[1]);
    themeKnopf.title = 'Farbschema: ' + t[1] + ' (antippen zum Wechseln)';
  }
  var themeWahl = 'auto';
  try { var gespeichert = localStorage.getItem(THEME_KEY); if (gespeichert === 'light' || gespeichert === 'dark') themeWahl = gespeichert; } catch (e) {}
  themeZeigen(themeWahl);
  if (themeKnopf) {
    themeKnopf.hidden = false;
    themeKnopf.addEventListener('click', function () {
      themeWahl = themeWahl === 'auto' ? 'light' : themeWahl === 'light' ? 'dark' : 'auto';
      try { if (themeWahl === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, themeWahl); } catch (e) {}
      themeZeigen(themeWahl);
    });
  }

  // Kanäle: welche Kachel offen war, merkt sich der Browser.
  var OPEN_KEY = 'handball-site-open';
  function offeneLesen() {
    try { var l = JSON.parse(localStorage.getItem(OPEN_KEY) || '[]'); return Array.isArray(l) ? l : []; } catch (e) { return []; }
  }
  var gemerkteOffene = offeneLesen();
  Array.prototype.forEach.call(document.querySelectorAll('details.channel[data-key]'), function (d) {
    var key = d.getAttribute('data-key');
    if (gemerkteOffene.indexOf(key) >= 0) d.open = true;
    d.addEventListener('toggle', function () {
      var liste = offeneLesen().filter(function (k) { return k !== key; });
      if (d.open) liste.push(key);
      try { localStorage.setItem(OPEN_KEY, JSON.stringify(liste)); } catch (e) {}
    });
  });

  // Countdown: „In 2 Std. 14 Min." für das nächste Spiel, solange es weniger als 36 Stunden sind.
  function countdown() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-countdown]'), function (el) {
      var ms = Date.parse(el.getAttribute('data-countdown')) - Date.now();
      if (!(ms > 0) || ms > 36 * 3600000) return;
      var min = Math.ceil(ms / 60000);
      el.textContent = min < 60 ? 'In ' + min + ' Min.' : 'In ' + Math.floor(min / 60) + ' Std. ' + (min % 60) + ' Min.';
    });
  }
  countdown();
  setInterval(countdown, 30000);

  // Offline-Hinweis.
  var offline = document.querySelector('[data-offline]');
  function netz() { if (offline) offline.hidden = navigator.onLine !== false; }
  window.addEventListener('online', netz);
  window.addEventListener('offline', netz);
  netz();

  // Spielplan filtern und zum nächsten Spiel springen.
  var filterWahl = 'alle';
  function planAnwenden() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-filter-bar]'), function (leiste) { leiste.hidden = false; });
    Array.prototype.forEach.call(document.querySelectorAll('#spielplan .plan li'), function (li) {
      li.hidden = !(filterWahl === 'alle' || li.getAttribute('data-ha') === filterWahl || li.getAttribute('data-st') === filterWahl);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-filter') === filterWahl ? 'true' : 'false');
    });
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-filter],[data-jump]') : null;
    if (!t) return;
    if (t.hasAttribute('data-filter')) { filterWahl = t.getAttribute('data-filter'); planAnwenden(); return; }
    var next = document.querySelector('#spielplan .plan li.next');
    if (!next) return;
    if (next.hidden) { filterWahl = 'alle'; planAnwenden(); }
    next.scrollIntoView({ block: 'center' });
  });
  planAnwenden();

  // Live-Modus: Läuft ein Spiel, holt die Seite alle 30 Sekunden ihren eigenen
  // Stand und tauscht Spielstand, Kopfzeile, Tabelle und Spielplan aus. Ist das
  // Spiel vorbei oder der Tab im Hintergrund, ruht sie.
  if (document.body.hasAttribute('data-live')) {
    var liveTakt = setInterval(function () {
      if (document.hidden) return;
      fetch(location.pathname + location.search, { cache: 'no-store', credentials: 'omit' })
        .then(function (res) { return res.ok ? res.text() : null; })
        .then(function (html) {
          if (!html) return;
          var doc = new DOMParser().parseFromString(html, 'text/html');
          ['naechstes', 'letztes', 'tabelle'].forEach(function (id) {
            var neu = doc.getElementById(id);
            var alt = document.getElementById(id);
            if (neu && alt) alt.replaceWith(neu);
          });
          var kopfNeu = doc.querySelector('.hero .stats');
          var kopfAlt = document.querySelector('.hero .stats');
          if (kopfNeu && kopfAlt) kopfAlt.replaceWith(kopfNeu);
          var planNeu = doc.getElementById('spielplan');
          var planAlt = document.getElementById('spielplan');
          if (planNeu && planAlt && !planAlt.querySelector('details[open]')) { planAlt.replaceWith(planNeu); planAnwenden(); }
          countdown();
          if (!doc.body.hasAttribute('data-live')) { document.body.removeAttribute('data-live'); clearInterval(liveTakt); }
        })
        .catch(function () {});
    }, 30000);
  }

  var root = document.getElementById('push');
  if (!root) return;
  var status = root.querySelector('[data-status]');
  var form = root.querySelector('[data-form]');
  var btnOn = root.querySelector('[data-subscribe]');
  var btnOff = root.querySelector('[data-unsubscribe]');
  var iosHint = root.querySelector('[data-ios]');
  var aktiv = root.querySelector('[data-aktiv]');
  var say = function (text) { status.textContent = text; };
  var isIos = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  var supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  if (root.getAttribute('data-push') !== '1') return;
  if (!supported) {
    if (isIos && !standalone) { say('Auf diesem Gerät geht das nur vom Home-Bildschirm aus.'); iosHint.hidden = false; }
    else say('Dieser Browser kann keine Benachrichtigungen — der Kalender unten geht trotzdem.');
    return;
  }

  var KEY = 'handball-site-push';
  function gemerkt() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function merken(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }
  function wahl() {
    var lead = form.querySelector('input[name=lead]:checked');
    var mode = form.querySelector('input[name=mode]:checked');
    return { lead: lead ? lead.value : '1h', mode: mode ? mode.value : 'all' };
  }
  function setzeWahl(v) {
    if (!v) return;
    var l = form.querySelector('input[name=lead][value="' + v.lead + '"]');
    var m = form.querySelector('input[name=mode][value="' + v.mode + '"]');
    if (l) l.checked = true;
    if (m) m.checked = true;
  }
  function bytes(base64) {
    var padding = '='.repeat((4 - (base64.length % 4)) % 4);
    var raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function zeige(sub) {
    form.hidden = false;
    if (aktiv) aktiv.hidden = !sub;
    if (sub) {
      btnOn.textContent = 'Auswahl speichern';
      btnOff.hidden = false;
      var w = wahl();
      say(w.lead === 'aus' && w.mode === 'results' ? 'Eingeschaltet: nur Endstände und Verlegungen.' : 'Eingeschaltet auf diesem Gerät.');
    } else {
      btnOn.textContent = 'Benachrichtigungen einschalten';
      btnOff.hidden = true;
      say(Notification.permission === 'denied'
        ? 'Benachrichtigungen sind für diese Seite blockiert — in den Browser-Einstellungen wieder erlauben.'
        : 'Noch nicht eingeschaltet.');
    }
  }

  var reg = null;
  var config = null;
  navigator.serviceWorker.register('./sw.js', { scope: './' })
    .then(function (r) { reg = r; return fetch('./push', { credentials: 'omit' }); })
    .then(function (res) { return res.json(); })
    .then(function (cfg) {
      config = cfg;
      if (!cfg.enabled || !cfg.public_key) { say('Benachrichtigungen sind auf diesem Server nicht eingerichtet — der Kalender geht trotzdem.'); return null; }
      return navigator.serviceWorker.ready.then(function () { return reg.pushManager.getSubscription(); });
    })
    .then(function (sub) {
      if (!config || !config.enabled) return;
      setzeWahl(gemerkt());
      zeige(sub);
    })
    .catch(function () { say('Benachrichtigungen lassen sich gerade nicht einrichten.'); });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!reg || !config) return;
    btnOn.disabled = true;
    say('Einen Moment …');
    Promise.resolve(Notification.permission === 'granted' ? 'granted' : Notification.requestPermission())
      .then(function (perm) {
        if (perm !== 'granted') { zeige(null); throw new Error('abgelehnt'); }
        return reg.pushManager.getSubscription().then(function (sub) {
          return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(config.public_key) });
        });
      })
      .then(function (sub) {
        var w = wahl();
        return fetch('./push', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit',
          body: JSON.stringify({ subscription: sub.toJSON(), lead: w.lead, mode: w.mode })
        }).then(function (res) { if (!res.ok) throw new Error('server'); merken(w); zeige(sub); });
      })
      .catch(function (err) { if (err && err.message !== 'abgelehnt') say('Das hat nicht geklappt — bitte noch einmal versuchen.'); })
      .then(function () { btnOn.disabled = false; });
  });

  btnOff.addEventListener('click', function () {
    if (!reg) return;
    btnOff.disabled = true;
    reg.pushManager.getSubscription().then(function (sub) {
      if (!sub) return null;
      return fetch('./push', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', body: JSON.stringify({ endpoint: sub.endpoint }) })
        .catch(function () {})
        .then(function () { return sub.unsubscribe(); });
    }).then(function () { zeige(null); say('Ausgeschaltet.'); }).catch(function () { say('Abmelden hat nicht geklappt.'); })
      .then(function () { btnOff.disabled = false; });
  });
})();
`;
