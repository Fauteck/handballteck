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
 * Textfarben, die auf Weiß beziehungsweise auf der dunklen Karte mindestens 4,5:1
 * erreichen (WCAG AA) — die Rohfarben `--ad`, `--win`, `--loss` und `--p` tun das
 * nicht überall. `lk` Links, `hd` Überschriften, `wint`/`losst` Sieg und
 * Niederlage als Text. Eine Quelle für das Stylesheet und den Kontrast-Test.
 */
export const KONTRAST = {
  hell: { lk: 'color-mix(in srgb,var(--ad) 70%,#000)', hd: 'var(--p)', wint: 'color-mix(in srgb,var(--win) 65%,#000)', losst: 'color-mix(in srgb,var(--loss) 80%,#000)' },
  dunkel: { lk: 'var(--a)', hd: 'var(--a)', wint: 'color-mix(in srgb,var(--win) 50%,#fff)', losst: 'color-mix(in srgb,var(--loss) 55%,#fff)' },
} as const;
const tokens = (t: Record<string, string>) => Object.entries(t).map(([k, v]) => `--${k}:${v}`).join(';');
const KONTRAST_HELL = tokens(KONTRAST.hell);
const KONTRAST_DUNKEL = tokens(KONTRAST.dunkel);

/**
 * Das dunkle Schema — zweimal ausgegeben: einmal für „automatisch" (folgt dem
 * Gerät, außer der Schalter steht auf hell), einmal für „dunkel" von Hand.
 * Eine Quelle, damit beide nie auseinanderlaufen.
 */
const DUNKEL: Array<[string, string]> = [
  ['', `--bg:#0c1a1f;--card:#12262c;--text:#e6f0f2;--muted:#9bb0b6;--line:#1f3840;${KONTRAST_DUNKEL};color-scheme:dark`],
  ['.btn', 'background:#12262c;color:#e6f0f2'],
  ['.plan .e', 'background:#0c1a1f;color:#e6f0f2'],
  ['tr.own td', 'background:color-mix(in srgb,var(--a) 16%,#12262c)'],
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
:root{--p:${p.primary};--s:${p.secondary};--a:${p.accent};--ad:${p.accentDark};--g:${grund};--bg:#f2f6f7;--card:#ffffff;--text:#10262c;--muted:#5d7178;--line:#dde6e9;--win:#1f9d55;--loss:#c9403a;--draw:#7a8a90;${KONTRAST_HELL}}
@font-face{font-family:'Barlow Condensed';font-weight:700;font-display:swap;src:url(./fonts/BarlowCondensed-Bold.ttf) format('truetype')}
@font-face{font-family:'Barlow Condensed';font-weight:600;font-display:swap;src:url(./fonts/BarlowCondensed-SemiBold.ttf) format('truetype')}
@font-face{font-family:'Barlow';font-weight:400;font-display:swap;src:url(./fonts/Barlow-Regular.ttf) format('truetype')}
@font-face{font-family:'Barlow';font-weight:500;font-display:swap;src:url(./fonts/Barlow-Medium.ttf) format('truetype')}
@font-face{font-family:'Barlow';font-weight:600;font-display:swap;src:url(./fonts/Barlow-SemiBold.ttf) format('truetype')}
*{box-sizing:border-box}
[hidden]{display:none !important}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 'Barlow',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
a{color:var(--lk)}
h1,h2,h3{font-family:'Barlow Condensed','Barlow',system-ui,sans-serif;letter-spacing:.01em;margin:0}
h2{font-size:1.5rem;font-weight:700;text-transform:uppercase;color:var(--hd);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
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
.teamwahl.gruppen a{font-size:1.05rem;padding:6px 16px}
.teamwahl:not(.gruppen) a{font-size:.85rem;padding:3px 10px}
.teamwahl a[aria-current]{background:var(--a);border-color:var(--a);color:var(--g)}
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
.s-next{order:1}.s-last{order:3}.s-table{order:4}.s-plan{order:5}.s-season{order:6}.s-fotos{order:7}.s-team{order:8}
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
.btn{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:10px 16px;border-radius:12px;border:1px solid var(--line);background:#fff;color:var(--p);font:inherit;font-weight:600;text-decoration:none;cursor:pointer;line-height:1.1}
.btn:hover{border-color:var(--ad)}
.btn.primary{background:var(--a);border-color:var(--a);color:var(--g)}
.btn.ghost{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.25);color:#fff}
.btn[disabled]{opacity:.55;cursor:default}
.muted{color:var(--muted)}
.dark .muted{color:rgba(255,255,255,.72)}
.small{font-size:.9rem}
.next .info{display:grid;gap:4px;margin-top:12px;font-size:1.05rem}
.next .info b{font-family:'Barlow Condensed',sans-serif;font-size:1.5rem;font-weight:700;text-transform:uppercase}
.live .livestand{display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:center;margin-top:12px;text-align:center}
.live .livestand .seite{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:1.15rem;text-transform:uppercase;line-height:1.15;overflow-wrap:anywhere}
.live .tore-gross{font-family:'Barlow Condensed',sans-serif;font-size:3.4rem;font-weight:700;line-height:1}
.livetore{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:4px;font-size:1rem}
.livetore .min{display:inline-block;min-width:2.4em;opacity:.7}
.result .stand{font-family:'Barlow Condensed',sans-serif;font-size:2.6rem;font-weight:700;line-height:1}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:8px 6px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-family:'Barlow Condensed',sans-serif;font-weight:600;text-transform:uppercase;font-size:.9rem;color:var(--muted);letter-spacing:.03em}
td.name,th.name{text-align:left;white-space:normal;width:100%}
tr.own td{background:color-mix(in srgb,var(--a) 14%,#fff);font-weight:600}
tr.own td:first-child{box-shadow:inset 4px 0 0 var(--a)}
td.pos{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:1.1rem;color:var(--hd)}
td.pkt{font-weight:700}
.t i{font-style:normal;font-size:.75rem;margin-left:4px}
.t i.up{color:var(--wint)}.t i.down{color:var(--losst)}
.legend{margin:10px 0 0;font-size:.85rem;color:var(--muted)}
.plan{list-style:none;margin:0;padding:0;display:grid}
.plan li{display:grid;grid-template-columns:96px 1fr auto;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
.plan li:last-child{border-bottom:0}
.plan .d{font-family:'Barlow Condensed',sans-serif;font-weight:600;color:var(--muted);line-height:1.1}
.plan .d small{display:block;font-weight:500}
.plan .g{min-width:0}
.plan .g a.titel{display:inline-block;padding:4px 0;color:inherit;text-decoration:none}
.plan .g a.spielseite{display:inline-flex;align-items:center;min-height:44px;padding:0 4px;font-weight:600}
.plan .g .ha{color:var(--muted);font-size:.85rem}
.plan .e{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:1.35rem;padding:2px 10px;border-radius:8px;background:var(--bg);color:var(--text)}
.plan .e.w{background:color-mix(in srgb,var(--win) 16%,#fff);color:var(--wint)}
.plan .e.l{background:color-mix(in srgb,var(--loss) 14%,#fff);color:var(--losst)}
.plan .e.o{color:var(--muted);font-weight:500;font-size:.95rem;background:transparent}
.plan li.next{background:color-mix(in srgb,var(--a) 10%,#fff);border-radius:10px;padding-left:8px;padding-right:8px;margin:0 -8px}
.lines{margin:0;padding-left:0;list-style:none;display:grid;gap:6px}
.lines li{padding-left:14px;position:relative}
.lines li::before{content:"";position:absolute;left:0;top:.55em;width:6px;height:6px;border-radius:50%;background:var(--a)}
.season .body{display:grid;gap:14px}
fieldset{border:0;padding:0;margin:0 0 10px}
legend{font-family:'Barlow Condensed',sans-serif;font-weight:600;text-transform:uppercase;font-size:.95rem;color:var(--a);margin-bottom:6px}
.opts{display:flex;gap:8px;flex-wrap:wrap}
.opts label{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:8px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.3);cursor:pointer;font-size:.95rem}
.opts input{accent-color:var(--a)}
.opts label:has(input:checked){background:rgba(255,255,255,.14);border-color:var(--a)}
.status{margin:6px 0 10px;font-weight:500}
.verpassen{grid-column:1/-1;justify-self:end;display:grid;gap:4px;justify-items:end;margin-right:52px}
.verpassen .titel{font-family:'Barlow Condensed',sans-serif;font-size:.8rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.75)}
.verpassen .icons{display:flex;gap:8px}
.vicon{position:relative;display:grid;place-items:center;width:44px;height:44px;padding:0;border-radius:12px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff;cursor:pointer;text-decoration:none}
.vicon:hover{background:rgba(255,255,255,.24)}
.vicon svg{width:22px;height:22px;fill:currentColor}
.vicon.tg{background:#29a9eb;border-color:#29a9eb}
.vicon.rss{background:#f28a1a;border-color:#f28a1a}
.vicon .punkt{position:absolute;top:6px;right:6px;width:10px;height:10px;border-radius:50%;background:var(--a);border:2px solid var(--g)}
dialog.popup{width:min(92vw,520px);max-height:90vh;overflow:auto;padding:20px;border:1px solid rgba(255,255,255,.24);border-radius:16px;background:var(--g);color:#fff}
dialog.popup::backdrop{background:rgba(0,0,0,.55)}
dialog.popup h2{color:#fff}
dialog.popup fieldset{border:0;margin:0 0 10px;padding:0}
dialog.popup legend{font-family:'Barlow Condensed',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:.85rem;color:var(--a);padding:0}
.teilen{gap:8px}.teilen svg{width:18px;height:18px;fill:currentColor}
.teilen.klein{min-height:44px;padding:6px 12px;font-size:.9rem;margin-left:auto;text-transform:none;font-family:'Barlow',sans-serif}
.card:not(.dark) .btn.teilen{color:var(--p)}
dialog.popup .teilziele{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:12px 0}
dialog.popup .teilziele .btn{justify-content:center}
dialog.popup .schliessen{margin:14px 0 0}
.lead{margin:6px 0 12px;color:rgba(255,255,255,.8)}
.kaesten{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;align-items:start;margin-top:4px}
.kasten{border-radius:16px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.22);color:#fff}
.kasten[open]{background:rgba(255,255,255,.16);border-color:var(--a)}
.kasten summary{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:84px;padding:14px 16px;cursor:pointer;list-style:none}
.kasten summary::-webkit-details-marker{display:none}
.kasten summary::after{content:"▾";font-size:1.2rem;color:var(--a);transition:transform .15s}
.kasten[open] summary::after{transform:rotate(180deg)}
.kasten .kopf{display:grid;gap:2px}
.kasten .kopf b{font-family:'Barlow Condensed',sans-serif;font-size:1.5rem;font-weight:700;text-transform:uppercase;line-height:1.05}
.kasten .kopf small{color:rgba(255,255,255,.75);font-size:.85rem}
.kasten.leer{opacity:.55;padding:14px 16px;min-height:84px;display:flex;align-items:center}
.kasten .liste{list-style:none;margin:0;padding:0 8px 10px;display:grid;gap:2px}
.kasten .liste a{display:flex;align-items:center;min-height:44px;padding:0 10px;border-radius:10px;color:#fff;text-decoration:none;font-weight:600}
.kasten .liste a:hover{background:rgba(255,255,255,.16)}
main.wrap.breit{grid-template-columns:minmax(0,1fr)}
.sortieren{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0 10px}
.sortieren button{font:inherit;font-size:.95rem;min-height:44px;padding:8px 16px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
.sortieren button[aria-pressed=true]{background:var(--p);border-color:var(--p);color:#fff}
.tabelle-rahmen{overflow-x:auto}
table.heim th,table.heim td{text-align:left;white-space:normal;vertical-align:top;padding:10px 8px}
table.heim small{display:block;color:var(--muted);font-size:.8rem;font-weight:500}
table.heim td.wann{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:1.1rem;white-space:nowrap}
table.heim td.team a{font-weight:700;text-decoration:none}
table.heim td.ort b{display:block}
table.heim td.ort a{display:inline-flex;align-items:center;min-height:44px;font-weight:600}
table.heim tr.neu td{border-top:3px solid var(--line)}
.erg{font-weight:700}.erg.w{color:var(--wint)}.erg.l{color:var(--losst)}
.mannschaften{list-style:none;margin:0;padding:0;display:grid}
.mannschaften li{padding:12px 0;border-bottom:1px solid var(--line);font-size:.95rem}
.mannschaften li:last-child{border-bottom:0}
.mannschaften a.titel{display:inline-block;padding:4px 0;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:1.2rem;text-transform:uppercase;color:var(--hd);text-decoration:none}
@media (max-width:640px){
table.heim thead{position:absolute;left:-9999px}
table.heim,table.heim tbody{display:block}
table.heim tr{display:grid;grid-template-columns:1fr;gap:2px;padding:12px 0;border-bottom:1px solid var(--line)}
table.heim td{display:block;padding:2px 0;border:0}
table.heim td::before{content:attr(data-label);display:block;font-family:'Barlow Condensed',sans-serif;font-size:.75rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
table.heim tr.neu{border-top:3px solid var(--line)}
table.heim tr.neu td{border-top:0}
}
.skip{position:absolute;left:-999px;top:8px;z-index:10;padding:8px 14px;border-radius:8px;background:#fff;color:#10262c}
.skip:focus{left:8px}
.offline{padding:8px 16px;text-align:center;background:#7a4b00;color:#fff;font-size:.9rem}
:focus-visible{outline:3px solid var(--a);outline-offset:2px;border-radius:4px}
.filter{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}
.filter button{font:inherit;font-size:.95rem;min-height:44px;padding:8px 16px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
.filter button[aria-pressed=true]{background:var(--p);border-color:var(--p);color:#fff}
.filter button.jump{margin-left:auto;border-style:dashed}
h3.unter{font-family:'Barlow Condensed',sans-serif;font-size:1.15rem;font-weight:700;text-transform:uppercase;color:var(--hd);margin:12px 0 4px}
.legende{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:4px 14px;font-size:.9rem}
.legende i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
.hero .theme{position:absolute;top:12px;right:16px;z-index:2;width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff;font-size:1.2rem;line-height:1;cursor:pointer}
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
details.more summary{cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.04em;font-size:.9rem;color:var(--lk);list-style:none;display:inline-flex;align-items:center;gap:6px;min-height:44px}
details.more summary::-webkit-details-marker{display:none}
details.more summary::before{content:"";width:0;height:0;border-left:6px solid currentColor;border-top:4px solid transparent;border-bottom:4px solid transparent;transition:transform .15s}
details.more[open] summary::before{transform:rotate(90deg)}
.card.dark details.more summary{color:var(--a)}
.card.dark .plan .d,.card.dark .plan .g .ha{color:rgba(255,255,255,.78)}
.card.dark .plan li{border-color:rgba(255,255,255,.16)}
.verlauf{margin:10px 0 4px}
.verlauf svg{display:block;width:100%;height:auto}
.torfolge{margin:6px 0 0;font-size:.85rem;color:var(--muted);line-height:1.6}
.torfolge b{color:var(--text)}
.bericht{margin-top:10px;font-size:.98rem;line-height:1.55}
.bericht h4{font-family:'Barlow Condensed',sans-serif;font-size:1.1rem;font-weight:700;text-transform:uppercase;color:var(--hd);margin:12px 0 4px}
.bericht p{margin:0 0 8px}
.bericht .quelle{font-size:.85rem;color:var(--muted)}
.toast{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:20;max-width:calc(100vw - 32px);padding:12px 20px;border-radius:14px;border:2px solid var(--a);background:var(--g);color:#fff;font-family:'Barlow Condensed',sans-serif;font-size:1.5rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em;box-shadow:0 8px 24px rgba(0,0,0,.35);text-align:center}
.livetore li b+b{margin-left:2px}
details.ticker{margin-top:6px}
.spielstand{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:12px;align-items:center;margin:6px 0 10px;text-align:center}
.spielstand .seite{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:1.2rem;text-transform:uppercase;line-height:1.15;hyphens:auto;overflow-wrap:break-word;min-width:0}
.spielstand .tore-gross{font-family:'Barlow Condensed',sans-serif;font-size:3.6rem;font-weight:700;line-height:1;color:var(--hd)}
.zurueck{display:inline-flex;align-items:center;min-height:44px;font-weight:600}
.schuetzen{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.schuetzen li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)}
.schuetzen li:last-child{border-bottom:0}
.tag{margin:14px 0 2px}
main.wrap.schmal{max-width:820px;grid-template-columns:minmax(0,1fr)}
footer.wrap{color:var(--muted);font-size:.85rem;padding-bottom:32px;display:grid;gap:6px}
footer .betreiber{padding-top:10px;border-top:1px solid var(--line)}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation:none !important;transition:none !important}}
@media (pointer:coarse){.teamwahl a,.teamwahl:not(.gruppen) a{display:inline-flex;align-items:center;min-height:44px;padding-top:0;padding-bottom:0}}
@media (max-width:600px){.spielstand .seite{font-size:1.05rem}.spielstand .tore-gross{font-size:2.8rem}.hide-sm{display:none}.hero img.logo,.hero .initialen{width:72px;height:72px}.plan li{grid-template-columns:78px 1fr auto}}
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
  // Nur die Mannschaftsseite trägt ein Manifest; Spiel- und Übersichtsseite liegen eine Ebene tiefer und haben keinen eigenen Worker.
  if ('serviceWorker' in navigator && document.querySelector('link[rel=manifest]')) navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function () {});

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

  // Kurzer Hinweis am unteren Rand (Feed-Adresse kopiert u. Ä.).
  var kurzTimer = null;
  function kurz(text) {
    var t = document.querySelector('.toast.kurz');
    if (!t) {
      t = document.createElement('div');
      t.className = 'toast kurz';
      t.setAttribute('role', 'status');
      t.setAttribute('aria-live', 'polite');
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.hidden = false;
    clearTimeout(kurzTimer);
    kurzTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  // Feed-Adresse kopieren (ein Feed lässt sich im Browser nur als rohes XML öffnen).
  Array.prototype.forEach.call(document.querySelectorAll('button[data-copy]'), function (knopf) {
    knopf.addEventListener('click', function () {
      var adresse = knopf.getAttribute('data-copy') || '';
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(adresse).then(function () { kurz('Feed-Adresse kopiert'); }, function () { kurz('Adresse: ' + adresse); });
      else kurz('Adresse: ' + adresse);
    });
  });

  // Heimspiele der Startseite sortieren: Datum, Spielort oder Herren · Damen · Jugend.
  // Ohne Skript bleibt die Tabelle nach Datum stehen; die Chips erscheinen erst mit Skript.
  var sortTabelle = document.querySelector('[data-sorttable]');
  if (sortTabelle) {
    var sortLeiste = document.querySelector('[data-sortbar]');
    var sortKey = {
      datum: function (z) { return z.getAttribute('data-ts') || ''; },
      ort: function (z) { return z.getAttribute('data-ort') || '\uffff'; },
      gruppe: function (z) { return z.getAttribute('data-gr') || '9'; }
    };
    var sortieren = function (art) {
      var koerper = sortTabelle.tBodies[0];
      var zeilen = Array.prototype.slice.call(koerper.rows);
      zeilen.sort(function (a, b) {
        var ka = sortKey[art](a), kb = sortKey[art](b);
        if (ka !== kb) return ka < kb ? -1 : 1;
        var ta = a.getAttribute('data-ts') || '', tb = b.getAttribute('data-ts') || '';
        return ta < tb ? -1 : ta > tb ? 1 : 0;
      });
      var davor = null;
      zeilen.forEach(function (z) {
        var k = art === 'datum' ? (z.getAttribute('data-ts') || '').slice(0, 10) : sortKey[art](z);
        z.classList.toggle('neu', art !== 'datum' && davor !== null && k !== davor);
        davor = k;
        koerper.appendChild(z);
      });
      Array.prototype.forEach.call(sortLeiste.querySelectorAll('[data-sort]'), function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-sort') === art ? 'true' : 'false');
      });
    };
    if (sortLeiste) {
      sortLeiste.hidden = false;
      sortLeiste.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-sort]') : null;
        if (b) sortieren(b.getAttribute('data-sort'));
      });
    }
  }

  // Teilen: auf dem Telefon das Menü des Geräts (mit dem Bild als Datei, wo es das kann),
  // sonst ein Fenster mit den Zielen und Link kopieren / Bild kopieren / Bild speichern.
  // Das Bild wird vorab geladen: Safari verlangt, dass share() sofort auf den Tipp folgt.
  var bilder = {};
  function bildLaden(rel) {
    var href = new URL(rel, location.href).href;
    if (!bilder[href]) bilder[href] = fetch(href, { credentials: 'omit' }).then(function (r) { return r.ok ? r.blob() : null; }).catch(function () { return null; });
    return bilder[href];
  }
  var teilKnoepfe = document.querySelectorAll('[data-teilen]');
  var bildBereit = {};
  Array.prototype.forEach.call(teilKnoepfe, function (k) {
    k.hidden = false;
    var rel = k.getAttribute('data-bild');
    if (rel) bildLaden(rel).then(function (b) { bildBereit[rel] = b; });
  });
  var teilDialog = null;
  function teilFenster(k) {
    var url = k.getAttribute('data-url') || location.href;
    var titel = k.getAttribute('data-titel') || document.title;
    var text = k.getAttribute('data-text') || titel;
    var rel = k.getAttribute('data-bild');
    var bildHref = rel ? new URL(rel, location.href).href : null;
    if (!teilDialog) {
      teilDialog = document.createElement('dialog');
      teilDialog.className = 'popup';
      teilDialog.addEventListener('click', function (ev) { if (ev.target === teilDialog) teilDialog.close(); });
      document.body.appendChild(teilDialog);
    }
    teilDialog.textContent = '';
    var h2 = document.createElement('h2'); h2.textContent = 'Teilen'; teilDialog.appendChild(h2);
    var p = document.createElement('p'); p.className = 'lead'; p.textContent = text; teilDialog.appendChild(p);
    var ziele = document.createElement('div'); ziele.className = 'teilziele';
    var enc = encodeURIComponent;
    [['WhatsApp', 'https://wa.me/?text=' + enc(text + ' ' + url)],
     ['Telegram', 'https://t.me/share/url?url=' + enc(url) + '&text=' + enc(text)],
     ['Facebook', 'https://www.facebook.com/sharer/sharer.php?u=' + enc(url)],
     ['LinkedIn', 'https://www.linkedin.com/sharing/share-offsite/?url=' + enc(url)]].forEach(function (z) {
      var a = document.createElement('a'); a.className = 'btn ghost'; a.textContent = z[0]; a.href = z[1];
      a.target = '_blank'; a.rel = 'noopener noreferrer'; ziele.appendChild(a);
    });
    function knopf(beschriftung, tat) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost'; b.textContent = beschriftung;
      b.addEventListener('click', function () { tat(b, beschriftung); }); ziele.appendChild(b);
    }
    function rueckmeldung(b, alt, ok) { b.textContent = ok ? 'Kopiert ✓' : 'Nicht möglich'; setTimeout(function () { b.textContent = alt; }, 2500); }
    knopf('Link kopieren', function (b, alt) {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(function () { rueckmeldung(b, alt, true); }, function () { rueckmeldung(b, alt, false); });
      else rueckmeldung(b, alt, false);
    });
    if (bildHref && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      knopf('Bild kopieren', function (b, alt) {
        var blob = bildLaden(rel).then(function (x) { if (!x) throw new Error('kein Bild'); return x.type === 'image/png' ? x : new Blob([x], { type: 'image/png' }); });
        navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(function () { rueckmeldung(b, alt, true); }, function () { rueckmeldung(b, alt, false); });
      });
    }
    if (bildHref) {
      var sp = document.createElement('a'); sp.className = 'btn ghost'; sp.textContent = 'Bild speichern'; sp.href = bildHref; sp.setAttribute('download', 'woelfe-im-revier.png'); ziele.appendChild(sp);
    }
    teilDialog.appendChild(ziele);
    var hinweis = document.createElement('p'); hinweis.className = 'muted small';
    hinweis.textContent = 'Signal und Instagram haben keinen Teilen-Link für Webseiten: Link kopieren oder Bild speichern und dort einfügen. Auf dem Telefon öffnet „Teilen" direkt das Menü des Geräts.';
    teilDialog.appendChild(hinweis);
    var zu = document.createElement('form'); zu.method = 'dialog'; zu.className = 'schliessen';
    var zub = document.createElement('button'); zub.className = 'btn ghost'; zub.type = 'submit'; zub.textContent = 'Schließen'; zu.appendChild(zub); teilDialog.appendChild(zu);
    if (typeof teilDialog.showModal === 'function') teilDialog.showModal(); else teilDialog.setAttribute('open', '');
  }
  document.addEventListener('click', function (ev) {
    var k = ev.target && ev.target.closest ? ev.target.closest('[data-teilen]') : null;
    if (!k) return;
    var url = k.getAttribute('data-url') || location.href;
    var titel = k.getAttribute('data-titel') || document.title;
    var text = k.getAttribute('data-text') || titel;
    var rel = k.getAttribute('data-bild');
    if (!navigator.share) { teilFenster(k); return; }
    var blob = rel ? bildBereit[rel] : null;
    var datei = null;
    try { datei = blob ? new File([blob], 'woelfe-im-revier.png', { type: 'image/png' }) : null; } catch (e) {}
    var mitBild = datei && navigator.canShare && navigator.canShare({ files: [datei] });
    // Mit Datei geht der Link in den Text: Viele Ziele verwerfen url, sobald eine Datei dabei ist.
    var daten = mitBild ? { files: [datei], title: titel, text: text + ' ' + url } : { title: titel, text: text, url: url };
    navigator.share(daten).catch(function (e) { if (!e || e.name !== 'AbortError') teilFenster(k); });
  });

  // Countdown: „In 2 Std. 14 Min." für das nächste Spiel, solange es weniger als 36 Stunden sind;
  // in der letzten Stunde zählt er sekundengenau („In 42:17 Min."), danach steht „Gleich los".
  function zwei(n) { return (n < 10 ? '0' : '') + n; }
  function countdown() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-countdown]'), function (el) {
      var ms = Date.parse(el.getAttribute('data-countdown')) - Date.now();
      var text;
      if (ms <= 0 && ms > -300000) text = 'Gleich los';
      else if (!(ms > 0) || ms > 36 * 3600000) return;
      else if (ms <= 3600000) { var s = Math.ceil(ms / 1000); text = 'In ' + zwei(Math.floor(s / 60)) + ':' + zwei(s % 60) + ' Min.'; }
      else { var min = Math.ceil(ms / 60000); text = 'In ' + Math.floor(min / 60) + ' Std. ' + (min % 60) + ' Min.'; }
      if (el.textContent !== text) el.textContent = text;
    });
  }
  countdown();
  setInterval(countdown, 1000);

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
  // Spiel vorbei oder der Tab im Hintergrund, ruht sie. Fällt dabei ein Tor,
  // zeigt ein kurzer Hinweis den neuen Stand und das Gerät vibriert (wo es das
  // kann) — ohne Ton, solange die Seite offen ist.
  if (document.body.hasAttribute('data-live')) {
    var hinweis = document.createElement('div');
    hinweis.className = 'toast';
    hinweis.setAttribute('role', 'status');
    hinweis.setAttribute('aria-live', 'polite');
    hinweis.hidden = true;
    document.body.appendChild(hinweis);
    var hinweisTimer = null;
    var standAus = function (wurzel) {
      var el = wurzel.querySelector('#naechstes [data-stand]');
      var m = el ? /^(\\d+):(\\d+)$/.exec(el.getAttribute('data-stand') || '') : null;
      return m ? { eigene: +m[1], gegner: +m[2], text: m[0] } : null;
    };
    var torHinweis = function (alt, neu) {
      if (!alt || !neu || (alt.eigene === neu.eigene && alt.gegner === neu.gegner)) return;
      var eigenes = neu.eigene > alt.eigene;
      hinweis.textContent = (eigenes ? 'Tor! ' : neu.gegner > alt.gegner ? 'Gegentor ' : 'Neuer Stand ') + neu.text;
      hinweis.hidden = false;
      clearTimeout(hinweisTimer);
      hinweisTimer = setTimeout(function () { hinweis.hidden = true; }, 6000);
      try { if (navigator.vibrate) navigator.vibrate(eigenes ? [120, 80, 120] : [220]); } catch (e) {}
    };
    var liveTakt = setInterval(function () {
      if (document.hidden) return;
      fetch(location.pathname + location.search, { cache: 'no-store', credentials: 'omit' })
        .then(function (res) { return res.ok ? res.text() : null; })
        .then(function (html) {
          if (!html) return;
          var doc = new DOMParser().parseFromString(html, 'text/html');
          torHinweis(standAus(document), standAus(doc));
          var tickerOffen = !!document.querySelector('#naechstes details.ticker[open]');
          ['naechstes', 'letztes', 'tabelle'].forEach(function (id) {
            var neu = doc.getElementById(id);
            var alt = document.getElementById(id);
            if (neu && alt) alt.replaceWith(neu);
          });
          var ticker = document.querySelector('#naechstes details.ticker');
          if (ticker && tickerOffen) ticker.open = true;
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

  // Das Benachrichtigungsfenster: Die Glocke im Kopf öffnet es, ein Klick daneben oder Esc schließt es.
  var root = document.getElementById('push');
  if (!root) return;
  var glocke = document.querySelector('[data-dialog-open=push]');
  if (glocke) {
    glocke.hidden = false;
    glocke.addEventListener('click', function () {
      if (typeof root.showModal === 'function') root.showModal(); else root.setAttribute('open', '');
    });
  }
  root.addEventListener('click', function (ev) { if (ev.target === root && typeof root.close === 'function') root.close(); });
  var status = root.querySelector('[data-status]');
  var form = root.querySelector('[data-form]');
  var btnOn = root.querySelector('[data-subscribe]');
  var btnOff = root.querySelector('[data-unsubscribe]');
  var iosHint = root.querySelector('[data-ios]');
  var aktiv = document.querySelector('[data-aktiv]');
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
