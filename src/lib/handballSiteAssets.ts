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
 * Eine Quelle, damit beide nie auseinanderlaufen. Flächen mischen mit
 * `var(--card)`, deshalb steht hier nur, was im Dunklen kräftiger gemischt wird.
 */
const DUNKEL: Array<[string, string]> = [
  ['', `--bg:#0c1a1f;--card:#12262c;--text:#e6f0f2;--muted:#9bb0b6;--line:#1f3840;${KONTRAST_DUNKEL};color-scheme:dark`],
  ['.btn', 'background:var(--card);color:var(--text)'],
  ['tr.own td', 'background:color-mix(in srgb,var(--a) 16%,var(--card))'],
  ['.plan li.next', 'background:color-mix(in srgb,var(--a) 14%,var(--card))'],
  ['.plan .e.w', 'background:color-mix(in srgb,var(--win) 24%,var(--card))'],
  ['.plan .e.l', 'background:color-mix(in srgb,var(--loss) 22%,var(--card))'],
  ['.kal .chip.w', 'background:color-mix(in srgb,var(--win) 24%,var(--card))'],
  ['.kal .chip.l', 'background:color-mix(in srgb,var(--loss) 22%,var(--card))'],
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
:root{--p:${p.primary};--s:${p.secondary};--a:${p.accent};--ad:${p.accentDark};--g:${grund};--bg:#f2f6f7;--card:#ffffff;--text:#10262c;--muted:#5d7178;--line:#dde6e9;--win:#1f9d55;--loss:#c9403a;--draw:#7a8a90;${KONTRAST_HELL};--on-dark:#fff;--on-dark-2:rgba(255,255,255,.75);--glass-1:rgba(255,255,255,.08);--glass-2:rgba(255,255,255,.14);--glass-line:rgba(255,255,255,.24);--skeleton:#0b2a33;--space-05:2px;--space-1:4px;--space-15:6px;--space-2:8px;--space-25:10px;--space-3:12px;--space-4:16px;--space-5:20px;--space-6:24px;--space-7:32px;--space-8:48px;--fs-xs:.75rem;--fs-sm:.875rem;--fs-base:1rem;--fs-md:1.15rem;--fs-lg:1.5rem;--fs-xl:1.75rem;--fs-2xl:2.6rem;--fs-3xl:3.5rem;--r-sm:8px;--r-md:12px;--r-lg:16px;--r-pill:999px}
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
h2{font-size:var(--fs-lg);font-weight:700;text-transform:uppercase;color:var(--hd);display:flex;align-items:center;gap:var(--space-25);flex-wrap:wrap}
.wrap{max-width:1180px;margin:0 auto;padding:0 16px 48px}
.hero{background:linear-gradient(135deg,var(--g) 0%,var(--p) 45%,var(--s) 100%);color:var(--on-dark);position:relative;overflow:hidden}
/* Die Liste eines Bereichskastens hängt als Overlay unter dem Kopf: nur seitlich beschneiden (der Kreis rechts), nach unten nicht. */
@supports (overflow:clip){.hero{overflow:visible;overflow-x:clip}}
.hero::before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(-55deg,rgba(255,255,255,.035) 0 2px,transparent 2px 14px);pointer-events:none}
.hero::after{content:"";position:absolute;right:-120px;top:-120px;width:420px;height:420px;border-radius:50%;border:38px solid var(--glass-1);pointer-events:none}
.hero .wrap{position:relative;padding-top:28px;padding-bottom:24px;display:grid;grid-template-columns:auto minmax(0,1fr);gap:var(--space-4) var(--space-5);align-items:center}
.hero img.logo{width:96px;height:96px;padding:10px;border-radius:50%;background:var(--glass-2);border:1px solid var(--glass-line);object-fit:contain;filter:drop-shadow(0 4px 12px rgba(0,0,0,.35))}
.hero .initialen{width:96px;height:96px;border-radius:50%;background:var(--glass-2);display:grid;place-items:center;font-family:'Barlow Condensed',sans-serif;font-size:var(--fs-2xl);font-weight:700;color:var(--a)}
.hero a.heim{color:inherit;text-decoration:none;display:block}
.hero a.heim.titel:hover h1{text-decoration:underline;text-decoration-thickness:3px;text-underline-offset:6px}
.hero .kicker{display:block;font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:var(--fs-base);letter-spacing:.04em;text-transform:uppercase;color:var(--a)}
.hero h1{font-size:clamp(1.8rem,5.5vw,3.2rem);font-weight:700;line-height:1.05;text-transform:uppercase;overflow-wrap:anywhere}
.hero h1 .nb{white-space:nowrap}
.hero .sub{margin-top:6px;color:var(--on-dark-2);font-size:var(--fs-base)}
.hero .stats{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:var(--space-25);margin-top:4px}
.stat{background:var(--glass-1);border:1px solid var(--glass-2);border-radius:var(--r-md);padding:10px 12px;min-width:0}
.stat b{display:block;font-family:'Barlow Condensed',sans-serif;font-size:var(--fs-xl);font-weight:700;line-height:1;color:var(--on-dark);white-space:nowrap}
.stat b.a{color:var(--a)}
.stat b small{font-size:var(--fs-base);font-weight:600;color:var(--on-dark-2);margin-left:4px}
.stat span{display:block;font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.04em;color:var(--on-dark-2);margin-top:5px}
.form{display:inline-flex;gap:var(--space-1);align-items:center;height:1.75rem}
.form i{display:inline-block;width:12px;height:12px;border-radius:50%;background:var(--draw)}
.form i.w{background:var(--win)}.form i.l{background:var(--loss)}
main.wrap{display:grid;gap:var(--space-5);padding-top:18px;grid-template-columns:minmax(0,1fr)}
.col{display:contents}
.s-next{order:1}.s-last{order:3}.s-table{order:4}.s-plan{order:5}.s-season{order:6}.s-team{order:7}.s-stats{order:8}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);padding:18px;box-shadow:0 1px 2px rgba(16,38,44,.04);min-width:0}
.card.dark{background:linear-gradient(135deg,var(--g),var(--p) 60%,var(--s));color:var(--on-dark);border-color:transparent}
.card.dark h2{color:var(--a)}
.card.dark a{color:var(--on-dark)}
.card h2{margin-bottom:10px}
.card img.bild{display:block;width:100%;height:auto;border-radius:var(--r-md);background:var(--skeleton)}
@keyframes skel{from{background-position:200% 0}to{background-position:-200% 0}}
.card img.bild.laedt{min-height:140px;color:transparent;background:linear-gradient(100deg,var(--skeleton) 30%,#16424e 50%,var(--skeleton) 70%);background-size:200% 100%;animation:skel 1.6s linear infinite}
.card img.bild.fehler{animation:none;background:var(--skeleton)}
.portraets img.laedt{color:transparent;background:linear-gradient(100deg,var(--line) 30%,color-mix(in srgb,var(--line) 50%,transparent) 50%,var(--line) 70%);background-size:200% 100%;animation:skel 1.6s linear infinite}
.portraets img.fehler{animation:none;background:var(--line)}
.badge{display:inline-flex;align-items:center;padding:3px 10px;border-radius:var(--r-pill);background:var(--a);color:var(--g);font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:var(--fs-base);letter-spacing:.04em;text-transform:uppercase}
.badge.live{background:var(--loss);color:var(--on-dark);animation:puls 1.6s ease-in-out infinite}
@keyframes puls{50%{opacity:.6}}
.row{display:flex;gap:var(--space-25);flex-wrap:wrap;align-items:center}
.btn{display:inline-flex;align-items:center;gap:var(--space-2);min-height:44px;padding:10px 16px;border-radius:var(--r-md);border:1px solid var(--line);background:var(--card);color:var(--p);font:inherit;font-weight:600;text-decoration:none;cursor:pointer;line-height:1.1}
.btn:hover{border-color:var(--ad)}
.btn.primary{background:var(--a);border-color:var(--a);color:var(--g)}
.btn.ghost{background:var(--glass-1);border-color:var(--glass-line);color:var(--on-dark)}
.btn[disabled]{opacity:.55;cursor:default}
.muted{color:var(--muted)}
.dark .muted{color:var(--on-dark-2)}
.small{font-size:var(--fs-sm)}
.next .info{display:grid;gap:var(--space-1);margin-top:12px;font-size:var(--fs-base)}
.next .info b{font-family:'Barlow Condensed',sans-serif;font-size:var(--fs-lg);font-weight:700;text-transform:uppercase}
.live .livestand{display:grid;grid-template-columns:1fr auto 1fr;gap:var(--space-3);align-items:center;margin-top:12px;text-align:center}
.live .livestand .seite{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:var(--fs-md);text-transform:uppercase;line-height:1.15;overflow-wrap:anywhere}
.live .tore-gross{font-family:'Barlow Condensed',sans-serif;font-size:var(--fs-3xl);font-weight:700;line-height:1}
.livetore{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:var(--space-1);font-size:var(--fs-base)}
.livetore .min{display:inline-block;min-width:2.4em;opacity:.7}
.livetore .werfer{opacity:.8}
.livetore li.eigen{font-weight:600}
.plan .stumm{display:inline-flex;align-items:center;gap:var(--space-15);min-height:44px;margin-top:6px;padding:4px 12px;border-radius:var(--r-pill);border:1px solid currentColor;background:transparent;color:inherit;font:inherit;font-size:var(--fs-sm);cursor:pointer;opacity:.85}
.plan .stumm[aria-pressed="false"]{opacity:.55}
#live .plan li{position:relative;cursor:pointer}
#live .plan a.titel::after{content:"";position:absolute;inset:0}
#live .plan .stumm{position:relative;z-index:1}
.result .stand{font-family:'Barlow Condensed',sans-serif;font-size:var(--fs-2xl);font-weight:700;line-height:1}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:8px 6px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-family:'Barlow Condensed',sans-serif;font-weight:600;text-transform:uppercase;font-size:var(--fs-sm);color:var(--muted);letter-spacing:.03em}
td.name,th.name{text-align:left;white-space:normal;width:100%}
tr.own td{background:color-mix(in srgb,var(--a) 14%,var(--card));font-weight:600}
tr.own td:first-child{box-shadow:inset 4px 0 0 var(--a)}
td.pos{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:var(--fs-md);color:var(--hd)}
td.pkt{font-weight:700}
.t i{font-style:normal;font-size:var(--fs-xs);margin-left:4px}
.t i.up{color:var(--wint)}.t i.down{color:var(--losst)}
.legend{margin:10px 0 0;font-size:var(--fs-sm);color:var(--muted)}
.plan{list-style:none;margin:0;padding:0;display:grid}
.plan li{display:grid;grid-template-columns:96px 1fr auto;gap:var(--space-25);align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
.plan li:last-child{border-bottom:0}
.plan .d{font-family:'Barlow Condensed',sans-serif;font-weight:600;color:var(--muted);line-height:1.1}
.plan .d small{display:block;font-weight:600}
.plan .g{min-width:0}
.plan .g a.titel{display:inline-flex;align-items:center;min-height:44px;color:inherit;text-decoration:none}
.plan .g a.spielseite{display:inline-flex;align-items:center;min-height:44px;padding:0 4px;font-weight:600}
.plan .g .ha{color:var(--muted);font-size:var(--fs-sm)}
.plan .e{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:var(--fs-lg);padding:2px 10px;border-radius:var(--r-sm);background:var(--bg);color:var(--text)}
.plan .e.w{background:color-mix(in srgb,var(--win) 16%,var(--card));color:var(--wint)}
.plan .e.l{background:color-mix(in srgb,var(--loss) 14%,var(--card));color:var(--losst)}
.plan .e.o{color:var(--muted);font-weight:600;font-size:var(--fs-base);background:transparent}
.plan li.next{background:color-mix(in srgb,var(--a) 10%,var(--card));border-radius:var(--r-md);padding-left:8px;padding-right:8px;margin:0 -8px}
.lines{margin:0;padding-left:0;list-style:none;display:grid;gap:var(--space-15)}
.lines li{padding-left:14px;position:relative}
.lines li::before{content:"";position:absolute;left:0;top:.55em;width:6px;height:6px;border-radius:50%;background:var(--a)}
.season .body{display:grid;gap:var(--space-4)}
fieldset{border:0;padding:0;margin:0 0 10px}
legend{font-family:'Barlow Condensed',sans-serif;font-weight:600;text-transform:uppercase;font-size:var(--fs-base);color:var(--a);margin-bottom:6px}
.opts{display:flex;gap:var(--space-2);flex-wrap:wrap}
.opts label{display:inline-flex;align-items:center;gap:var(--space-15);min-height:44px;padding:8px 14px;border-radius:var(--r-pill);border:1px solid var(--glass-line);cursor:pointer;font-size:var(--fs-base)}
.opts input{accent-color:var(--a)}
.opts label:has(input:checked){background:var(--glass-2);border-color:var(--a)}
.status{margin:6px 0 10px;font-weight:500}
.verpassen{grid-column:1/-1;justify-self:end;display:grid;gap:var(--space-1);justify-items:end;margin-right:52px}
.verpassen .titel{font-family:'Barlow Condensed',sans-serif;font-size:var(--fs-xs);font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--on-dark-2)}
.verpassen .icons{display:flex;gap:var(--space-2)}
.vicon{position:relative;display:grid;place-items:center;width:44px;height:44px;padding:0;border-radius:var(--r-md);border:1px solid var(--glass-line);background:var(--glass-2);color:var(--on-dark);cursor:pointer;text-decoration:none}
.vicon:hover{background:var(--glass-line)}
.vicon svg{width:22px;height:22px;fill:currentColor}
.vicon.tg{background:#29a9eb;border-color:#29a9eb}
.vicon.rss{background:#f28a1a;border-color:#f28a1a}
.vicon .punkt{position:absolute;top:6px;right:6px;width:10px;height:10px;border-radius:50%;background:var(--a);border:2px solid var(--g)}
dialog.popup{width:min(92vw,520px);max-height:90vh;overflow:auto;padding:20px;border:1px solid var(--glass-line);border-radius:var(--r-lg);background:var(--g);color:var(--on-dark)}
dialog.popup::backdrop{background:rgba(0,0,0,.55)}
dialog.popup h2{color:var(--on-dark)}
dialog.popup fieldset{border:0;margin:0 0 10px;padding:0}
dialog.popup legend{font-family:'Barlow Condensed',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.04em;font-size:var(--fs-sm);color:var(--a);padding:0}
.thema{display:flex;gap:var(--space-25);align-items:flex-start;padding:10px 0;cursor:pointer;min-height:44px}
.thema input{margin-top:4px;width:20px;height:20px;accent-color:var(--a);flex:none}
.thema b{display:block;font-weight:600}
.thema small{display:block;color:var(--on-dark-2);font-size:var(--fs-sm);line-height:1.35}
.einzug{margin:0 0 6px 30px}
.einzug[hidden]{display:none}
svg.ico{width:1.15em;height:1.15em;fill:currentColor;flex:none;vertical-align:-.2em}
.teilen{gap:var(--space-2)}.teilen svg{width:18px;height:18px;fill:currentColor}
.teilen.klein{min-height:44px;padding:6px 12px;font-size:var(--fs-sm);margin-left:auto;text-transform:none;font-family:'Barlow',sans-serif}
.card:not(.dark) .btn.teilen{color:var(--p)}
dialog.popup .teilziele{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--space-2);margin:12px 0}
dialog.popup .teilziele .btn{justify-content:center}
dialog.popup .schliessen{margin:14px 0 0}
.lead{margin:6px 0 12px;color:var(--on-dark-2)}
.kaesten{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--space-25);align-items:start;margin:0 0 6px}
/* Logo und Vereinsname ganz oben, die Wege daneben (links vom Farbschalter) statt in einer eigenen Zeile; das Team steht als Text unter der Navigation */
.hero .wrap{padding-top:16px}
.hero .verpassen{position:absolute;top:10px;right:68px;margin:0;z-index:2}
.hero .teaminfo{grid-column:1/-1;min-width:0}
.hero .verein{min-width:0}
.hero .verein a.heim{display:flex;align-items:center;min-height:44px}
.hero .verein .kicker{font-size:var(--fs-md)}
html.kompakt .hero .verein{display:none}
html.kompakt .hero .verpassen{position:static;grid-column:1/-1;justify-self:end}
@media (max-width:640px){
.hero .verein{grid-column:2;grid-row:1}
.hero .verein .kicker{font-size:var(--fs-base);letter-spacing:.04em}
.hero .wrap>a.heim{grid-row:1/3}
.hero .verpassen{position:static;grid-column:2;grid-row:2;justify-self:start;justify-items:start;align-self:start}
}
.verpassen+.kaesten{margin-top:-4px}
.hero .theme+.kaesten{margin-top:44px}
html.kompakt .hero .theme+.kaesten{margin-top:0}
.kasten{position:relative;border-radius:var(--r-lg);background:var(--glass-1);border:1px solid var(--glass-line);color:var(--on-dark)}
.kasten[open]{z-index:40}
.kasten[open]{background:var(--glass-2);border-color:var(--a)}
.kasten.aktiv{border-color:var(--a)}
.kasten.alle{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);min-height:84px;padding:14px 16px;text-decoration:none}
.kasten.alle::after{content:"→";font-size:var(--fs-md);color:var(--a)}
.kasten.alle:hover{background:var(--glass-2)}
.kaesten.flach .kasten summary,.kaesten.flach .kasten.leer,.kaesten.flach .kasten.alle{min-height:56px;padding:8px 14px}
.kaesten.flach .kasten .kopf b{font-size:var(--fs-md)}
.kaesten.flach .kasten .kopf small{display:none}
.kaesten.flach{grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:var(--space-2)}
.kasten .liste a[aria-current]{background:var(--a);color:var(--g)}
.kasten summary{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);min-height:84px;padding:14px 16px;cursor:pointer;list-style:none}
.kasten summary::-webkit-details-marker{display:none}
.kasten summary::after{content:"▾";font-size:var(--fs-md);color:var(--a);transition:transform .15s}
.kasten[open] summary::after{transform:rotate(180deg)}
.kasten .kopf{display:grid;gap:var(--space-05)}
.kasten .kopf b{font-family:'Barlow Condensed',sans-serif;font-size:var(--fs-lg);font-weight:700;text-transform:uppercase;line-height:1.05}
.kasten .kopf small{color:var(--on-dark-2);font-size:var(--fs-sm)}
.kasten.leer{opacity:.55;padding:14px 16px;min-height:84px;display:flex;align-items:center}
.kasten .liste{position:absolute;top:calc(100% + 6px);left:-1px;right:-1px;list-style:none;margin:0;padding:8px;display:grid;gap:var(--space-05);background:var(--g);border:1px solid var(--a);border-radius:var(--r-lg);box-shadow:0 12px 28px rgba(0,0,0,.4);max-height:min(60vh,420px);overflow-y:auto}
.kasten .liste a{display:flex;align-items:center;min-height:44px;padding:0 10px;border-radius:var(--r-md);color:var(--on-dark);text-decoration:none;font-weight:600}
.kasten .liste a:hover{background:var(--glass-2)}
main.wrap.breit{grid-template-columns:minmax(0,1fr)}
.sortieren{display:flex;flex-wrap:wrap;gap:var(--space-15);align-items:center;margin:4px 0 10px}
.sortieren button{font:inherit;font-size:var(--fs-base);min-height:44px;padding:8px 16px;border-radius:var(--r-pill);border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
.sortieren button[aria-pressed=true]{background:var(--p);border-color:var(--p);color:var(--on-dark)}
.tabelle-rahmen{overflow-x:auto}
table.heim th,table.heim td{text-align:left;white-space:normal;vertical-align:top;padding:10px 8px}
table.heim small{display:block;color:var(--muted);font-size:var(--fs-xs);font-weight:500}
table.heim td.wann{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:var(--fs-md);white-space:nowrap}
table.heim td.team a{display:inline-flex;align-items:center;min-height:44px;font-weight:700;text-decoration:none}
table.heim td.ort b{display:block}
table.stand tr.bereich th{text-align:left;padding-top:14px;font-family:'Barlow Condensed',sans-serif;font-size:var(--fs-base);font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--hd);border-bottom:2px solid var(--line)}
table.stand td b{font-family:'Barlow Condensed',sans-serif;font-size:var(--fs-md);font-weight:700;color:var(--hd)}
table.heim td.ort a{display:inline-flex;align-items:center;min-height:44px;font-weight:600}
table.heim tr.neu td{border-top:3px solid var(--line)}
.erg{font-weight:700}.erg.w{color:var(--wint)}.erg.l{color:var(--losst)}
.mannschaften{list-style:none;margin:0;padding:0;display:grid}
.mannschaften li{padding:12px 0;border-bottom:1px solid var(--line);font-size:var(--fs-base)}
.mannschaften li:last-child{border-bottom:0}
.mannschaften a.titel{display:inline-block;padding:4px 0;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:var(--fs-md);text-transform:uppercase;color:var(--hd);text-decoration:none}
@media (max-width:640px){
table.heim:not(.stand) thead{position:absolute;left:-9999px}
table.heim:not(.stand),table.heim:not(.stand) tbody{display:block}
table.heim:not(.stand) tr{display:grid;grid-template-columns:1fr;gap:var(--space-05);padding:12px 0;border-bottom:1px solid var(--line)}
table.heim:not(.stand) td{display:block;padding:2px 0;border:0}
table.heim:not(.stand) td::before{content:attr(data-label);display:block;font-family:'Barlow Condensed',sans-serif;font-size:var(--fs-xs);font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
table.heim tr.neu{border-top:3px solid var(--line)}
table.stand th,table.stand td{padding:8px 4px;font-size:var(--fs-sm)}
table.heim tr.neu td{border-top:0}
}
.skip{position:absolute;left:-999px;top:8px;z-index:10;padding:8px 14px;border-radius:var(--r-sm);background:var(--card);color:#10262c}
.skip:focus{left:8px}
.offline{padding:8px 16px;text-align:center;background:#7a4b00;color:var(--on-dark);font-size:var(--fs-sm)}
:focus-visible{outline:3px solid var(--a);outline-offset:2px}
.filter{display:flex;flex-wrap:wrap;gap:var(--space-15);margin:0 0 10px}
.filter button{font:inherit;font-size:var(--fs-base);min-height:44px;padding:8px 16px;border-radius:var(--r-pill);border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
.filter button[aria-pressed=true]{background:var(--p);border-color:var(--p);color:var(--on-dark)}
.filter button.jump{margin-left:auto;border-style:dashed}
.filter .ansicht{display:inline-flex;gap:var(--space-15);margin-right:8px}
#spielplan[data-ansicht=kalender] .plan,#spielplan[data-ansicht=kalender] .liste-nur{display:none}
#spielplan:not([data-ansicht=kalender]) .kal{display:none}
.kal .monatskopf{display:flex;align-items:center;justify-content:space-between;margin:4px 0 8px}
.kal .monatskopf b{font-family:'Barlow Condensed',sans-serif;font-size:var(--fs-lg);text-transform:uppercase;letter-spacing:.02em}
.kal .monatskopf button{font:inherit;font-size:var(--fs-lg);min-width:44px;min-height:44px;border-radius:var(--r-pill);border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
.kal .raster{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:var(--space-1)}
.kal .wt{text-align:center;font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.kal .tag{min-height:64px;padding:3px;border:1px solid var(--line);border-radius:var(--r-sm);display:flex;flex-direction:column;gap:var(--space-05);min-width:0}
.kal .tag.leer{border:0}
.kal .tag .n{font-size:var(--fs-xs);color:var(--muted);line-height:1}
.kal .tag.heute{border-color:var(--p);box-shadow:inset 0 0 0 1px var(--p)}
.kal a.tag{color:inherit;text-decoration:none}
.kal a.tag:hover{border-color:var(--p)}
.kal .chip{display:block;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:var(--fs-sm);padding:1px 3px;border-radius:var(--r-sm);background:var(--bg);color:var(--text);text-decoration:none;text-align:center;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:clip}
.kal .chip.aus{border:1px dashed var(--muted)}
.kal .chip.w{background:color-mix(in srgb,var(--win) 16%,var(--card));color:var(--wint)}
.kal .chip.l{background:color-mix(in srgb,var(--loss) 14%,var(--card));color:var(--losst)}
.livehinweis{display:flex;gap:var(--space-25);align-items:flex-start;margin:10px 0 0;font-size:var(--fs-base);line-height:1.4}
.livehinweis .punkt{flex:none;width:10px;height:10px;margin-top:6px;border-radius:50%;background:var(--loss)}
.card.live-leer{border-style:dashed}
.geltung{margin:0 0 8px;font-size:var(--fs-sm);line-height:1.4;color:var(--on-dark-2)}
.geltung a{color:var(--a)}
.kenn{display:flex;flex-wrap:wrap;gap:var(--space-2);margin:0 0 12px}
.kenn>div{border:1px solid var(--line);border-radius:var(--r-md);padding:6px 12px;min-width:0}
.kenn dt{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.kenn dd{margin:0;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:var(--fs-lg);line-height:1.1}
.kenn dd small{font-size:var(--fs-sm);font-weight:600;color:var(--muted);margin-left:5px}
tr[data-sb]{cursor:pointer}
tr[data-sb] td{padding-top:10px;padding-bottom:10px}
tr[data-sb]:hover td{background:color-mix(in srgb,var(--p) 6%,transparent)}
tr[data-sb]:focus-visible{outline:2px solid var(--p);outline-offset:-2px}
dialog.steckbrief .gegner{margin-top:0}
.klappe{margin-left:auto;font:inherit;font-family:'Barlow',sans-serif;font-size:var(--fs-sm);font-weight:500;text-transform:none;letter-spacing:0;min-height:44px;padding:6px 14px;border-radius:var(--r-pill);border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
.card.dark .klappe{background:var(--glass-1);border-color:var(--glass-line);color:var(--on-dark)}
.vorschau{margin:0;color:var(--muted);cursor:pointer}
[data-klappe].zu:not(#spielplan)>:not(h2):not(.vorschau){display:none}
#spielplan.zu .filter,#spielplan.zu .kal{display:none}
#spielplan.zu .plan li:not([data-kurz]){display:none}
#spielplan.zu[data-ansicht=kalender] .plan{display:grid}
.sprung{position:sticky;top:var(--oben,0px);z-index:25;background:var(--bg);border-bottom:1px solid var(--line)}
.sprung .wrap{padding-top:8px;padding-bottom:8px}
.sprung ul{list-style:none;margin:0;padding:0;display:flex;gap:var(--space-15);overflow-x:auto;scrollbar-width:none}
.sprung ul::-webkit-scrollbar{display:none}
.sprung a{display:inline-flex;align-items:center;min-height:44px;padding:6px 16px;border-radius:var(--r-pill);border:1px solid var(--line);background:var(--card);color:var(--text);text-decoration:none;white-space:nowrap;font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:var(--fs-base);letter-spacing:.02em}
.sprung a:hover{border-color:var(--p)}
.sprung a[aria-current=true]{background:var(--p);border-color:var(--p);color:var(--on-dark)}
section[id]{scroll-margin-top:72px}
html.mit-mini section[id]{scroll-margin-top:124px}
.mini{position:fixed;top:0;left:0;right:0;z-index:30;display:flex;align-items:center;gap:var(--space-25);padding:calc(6px + env(safe-area-inset-top)) 16px 6px;background:var(--g);color:var(--on-dark);box-shadow:0 2px 10px rgba(0,0,0,.3);transform:translateY(-110%);transition:transform .2s}
.mini.sichtbar{transform:none}
.mini .mlogo{display:grid;place-items:center;width:44px;height:44px;flex:none;border-radius:50%;background:var(--glass-2);text-decoration:none}
.mini .mlogo img{width:26px;height:26px;object-fit:contain}
.mini .ini{font-family:'Barlow Condensed',sans-serif;font-weight:700;color:var(--a);font-size:var(--fs-sm)}
.mini b{font-family:'Barlow Condensed',sans-serif;font-size:var(--fs-md);text-transform:uppercase;white-space:nowrap}
.mini .minfo{min-width:0;flex:1;font-size:var(--fs-sm);color:var(--on-dark-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mini .nachoben{font:inherit;font-size:var(--fs-md);min-width:44px;min-height:44px;border-radius:var(--r-pill);border:1px solid var(--glass-line);background:transparent;color:var(--on-dark);cursor:pointer}
html.kompakt .mini{display:none}
/* UXA-1: Im Rahmen mit angepasster Höhe ist der ganze Rahmen das Fenster; die Vereinsseite meldet, welcher Teil zu sehen ist. */
html.eingebettet{scroll-behavior:auto}
html.eingebettet .sprung{top:var(--sicht-oben,0px)}
html.eingebettet .toast{bottom:auto;top:calc(var(--sicht-oben,0px) + var(--sicht-hoehe,100vh) - 96px)}
html.eingebettet dialog.popup[open]{position:absolute;top:calc(var(--sicht-oben,0px) + 16px);bottom:auto;margin-top:0;max-height:calc(var(--sicht-hoehe,100vh) - 32px)}
h3.unter{font-family:'Barlow Condensed',sans-serif;font-size:var(--fs-md);font-weight:700;text-transform:uppercase;color:var(--hd);margin:12px 0 4px}
.legende{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:var(--space-1) var(--space-4);font-size:var(--fs-sm)}
.legende i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
.hero .theme{position:absolute;top:12px;right:16px;z-index:2;width:44px;height:44px;border-radius:50%;border:1px solid var(--glass-line);background:var(--glass-2);color:var(--on-dark);font-size:var(--fs-md);line-height:1;cursor:pointer}
.hero .theme:hover{background:var(--glass-line)}
html.kompakt .hero img.logo,html.kompakt .hero .initialen,html.kompakt .hero .kicker,html.kompakt .hero .theme,html.kompakt footer .betreiber{display:none}
html.kompakt .hero .wrap{grid-template-columns:minmax(0,1fr);padding-top:16px;padding-bottom:16px}
html.kompakt .hero h1{font-size:clamp(1.5rem,4.5vw,2.4rem)}
html.kompakt .verpassen{margin-right:0}
.vorschau-band{padding:8px 16px;text-align:center;background:#7a2a8a;color:var(--on-dark);font-size:var(--fs-sm);font-weight:600}
.portraets{list-style:none;margin:6px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:var(--space-3)}
.portraets li{display:grid;gap:var(--space-05);font-size:var(--fs-sm);line-height:1.25}
.portraets img{width:100%;height:auto;aspect-ratio:4/5;object-fit:cover;border-radius:var(--r-md);background:var(--line)}
.portraets b{margin-top:4px}
.portraets span{color:var(--muted);font-size:var(--fs-xs)}
.gegner{margin-top:14px;padding:12px 14px;border-radius:var(--r-lg);background:var(--glass-1);border:1px solid var(--glass-2);display:grid;gap:var(--space-2)}
.gegner .kopf{display:flex;gap:var(--space-3);align-items:center}
.gegner .kopf img,.gegner .kopf .ini{width:44px;height:44px;border-radius:50%;background:var(--card);object-fit:contain;flex:none}
.gegner .kopf .ini{display:grid;place-items:center;font-family:'Barlow Condensed',sans-serif;font-weight:700;color:var(--p);background:var(--on-dark-2)}
.gegner .kopf b{display:block;font-family:'Barlow Condensed',sans-serif;font-size:var(--fs-md);font-weight:700;text-transform:uppercase;letter-spacing:.02em;line-height:1.1}
.gegner .kopf span{display:block;font-size:var(--fs-sm);color:var(--on-dark-2)}
.gegner .zeile{display:flex;gap:var(--space-25);align-items:baseline;flex-wrap:wrap;font-size:var(--fs-base)}
.gegner .zeile .lbl{font-family:'Barlow Condensed',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.04em;font-size:var(--fs-xs);color:var(--a);min-width:92px}
.gegner .form i{width:11px;height:11px}
.gegner .res{color:var(--on-dark-2)}
details.more{grid-column:1/-1;margin-top:6px}
details.more summary{cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.04em;font-size:var(--fs-sm);color:var(--lk);list-style:none;display:inline-flex;align-items:center;gap:var(--space-15);min-height:44px}
details.more summary::-webkit-details-marker{display:none}
details.more summary::before{content:"";width:0;height:0;border-left:6px solid currentColor;border-top:4px solid transparent;border-bottom:4px solid transparent;transition:transform .15s}
details.more[open] summary::before{transform:rotate(90deg)}
.card.dark details.more summary{color:var(--a)}
.card.dark .plan .d,.card.dark .plan .g .ha{color:var(--on-dark-2)}
.card.dark .plan li{border-color:var(--glass-2)}
.verlauf{margin:10px 0 4px}
.verlauf svg{display:block;width:100%;height:auto}
.torfolge{margin:6px 0 0;font-size:var(--fs-sm);color:var(--muted);line-height:1.6}
.torfolge b{color:var(--text)}
.bericht{margin-top:10px;font-size:var(--fs-base);line-height:1.55}
.bericht h4{font-family:'Barlow Condensed',sans-serif;font-size:var(--fs-md);font-weight:700;text-transform:uppercase;color:var(--hd);margin:12px 0 4px}
.bericht p{margin:0 0 8px}
.bericht .quelle{font-size:var(--fs-sm);color:var(--muted)}
.toast{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:20;max-width:calc(100vw - 32px);padding:12px 20px;border-radius:var(--r-lg);border:2px solid var(--a);background:var(--g);color:var(--on-dark);font-family:'Barlow Condensed',sans-serif;font-size:var(--fs-lg);font-weight:700;text-transform:uppercase;letter-spacing:.03em;box-shadow:0 8px 24px rgba(0,0,0,.35);text-align:center}
.livetore li b+b{margin-left:2px}
details.ticker{margin-top:6px}
.spielstand{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:var(--space-3);align-items:center;margin:6px 0 10px;text-align:center}
.spielstand .seite{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:var(--fs-md);text-transform:uppercase;line-height:1.15;hyphens:auto;overflow-wrap:break-word;min-width:0}
.spielstand .tore-gross{font-family:'Barlow Condensed',sans-serif;font-size:var(--fs-3xl);font-weight:700;line-height:1;color:var(--hd)}
.zurueck{display:inline-flex;align-items:center;min-height:44px;font-weight:600}
.schuetzen{list-style:none;margin:0;padding:0;display:grid;gap:var(--space-05)}
.schuetzen li{display:flex;justify-content:space-between;gap:var(--space-3);padding:8px 0;border-bottom:1px solid var(--line)}
.schuetzen li:last-child{border-bottom:0}
.tag{margin:14px 0 2px}
main.wrap.schmal{max-width:820px;grid-template-columns:minmax(0,1fr)}
footer.wrap{color:var(--muted);font-size:var(--fs-sm);padding-bottom:32px;display:grid;gap:var(--space-15)}
footer .betreiber{padding-top:10px;border-top:1px solid var(--line)}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation:none !important;transition:none !important}}
@media (max-width:640px){.kal .raster{gap:var(--space-1)}.kal .tag{padding:2px;min-height:58px}.kal .chip{font-size:var(--fs-xs);padding:1px 0}.spielstand .seite{font-size:var(--fs-base)}.spielstand .tore-gross{font-size:var(--fs-2xl)}.hide-sm{display:none}.hero img.logo,.hero .initialen{width:72px;height:72px;padding:6px}.hero .initialen{font-size:var(--fs-lg)}.hero .kicker,.hero h1{padding-right:52px}html.kompakt .hero h1{padding-right:0}.plan li{grid-template-columns:78px 1fr auto}}
@media (min-width:960px){
main.wrap{grid-template-columns:minmax(0,1fr) 400px;align-items:start;gap:var(--space-6);padding-top:22px}
.col{display:grid;gap:var(--space-6);min-width:0}
.hero .wrap{padding-top:36px;padding-bottom:32px;grid-template-columns:auto max-content minmax(0,1fr);gap:var(--space-4) var(--space-7)}
.hero .wrap>div:not(.stats):not(.verein):not(.teaminfo){max-width:440px}
.hero .verein{grid-column:2/-1}
.hero .teaminfo{grid-column:1/3}
.hero h1{white-space:nowrap;overflow-wrap:normal}
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
if (/[?&]kompakt=1(&|$)/.test(location.search)) document.documentElement.className += ' kompakt';
// UXA-2: Die Vereinsseite legt das Farbschema fest (?farbe=dunkel|hell); das schlägt Gerät und gespeicherte Wahl.
var farbe = /[?&]farbe=(dunkel|hell)(&|$)/.exec(location.search);
if (farbe) document.documentElement.setAttribute('data-theme', farbe[1] === 'dunkel' ? 'dark' : 'light');
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

  // Eingebettet in die Vereinsseite (?kompakt=1, ?farbe=…): beide Angaben wandern mit jedem Verweis innerhalb der Seite.
  var mitnehmen = ['kompakt=1'];
  var farbeVorgabe = /[?&]farbe=(dunkel|hell)(&|$)/.exec(location.search);
  if (farbeVorgabe) mitnehmen.push('farbe=' + farbeVorgabe[1]);
  if (!/[?&]kompakt=1(&|$)/.test(location.search)) mitnehmen.shift();
  if (mitnehmen.length > 0) {
    Array.prototype.forEach.call(document.querySelectorAll('a[href]'), function (a) {
      var href = a.getAttribute('href') || '';
      if (/^(https?:|mailto:|webcal:|#)/.test(href) || a.hasAttribute('download') || a.hasAttribute('data-install')) return;
      var teile = href.split('#');
      var fehlt = mitnehmen.filter(function (p) { return teile[0].indexOf(p.split('=')[0] + '=') < 0; });
      if (fehlt.length === 0) return;
      a.setAttribute('href', teile[0] + (teile[0].indexOf('?') >= 0 ? '&' : '?') + fehlt.join('&') + (teile[1] ? '#' + teile[1] : ''));
    });
  }

  // UXA-1/UXA-2: Im Rahmen der Vereinsseite meldet die Seite ihre Höhe und jeden Seitenwechsel nach außen.
  // Das Skript der Vereinsseite (README → Einbetten) passt damit den Rahmen an und springt nach
  // einem Klick zum Anfang des Rahmens. Es meldet zurück, welcher Teil des Rahmens gerade zu sehen
  // ist; daran richten sich Fenster, Hinweis und Sprungleiste aus. Ohne dieses Skript bleibt alles wie bisher.
  var imRahmen = true;
  try { imRahmen = window.top !== window.self; } catch (e) {}
  if (imRahmen && window.parent && typeof window.parent.postMessage === 'function') {
    var melden = function (nachricht) { nachricht.quelle = 'woelfe-live'; try { window.parent.postMessage(nachricht, '*'); } catch (e) {} };
    var letzteHoehe = 0, hoeheGeplant = false;
    var hoeheMelden = function () {
      hoeheGeplant = false;
      var hoehe = Math.ceil(document.body.getBoundingClientRect().height);
      if (hoehe > 0 && Math.abs(hoehe - letzteHoehe) >= 2) { letzteHoehe = hoehe; melden({ typ: 'hoehe', hoehe: hoehe }); }
    };
    var hoehePlanen = function () { if (!hoeheGeplant) { hoeheGeplant = true; requestAnimationFrame(hoeheMelden); } };
    if (typeof ResizeObserver === 'function') new ResizeObserver(hoehePlanen).observe(document.body);
    window.addEventListener('load', hoehePlanen);
    melden({ typ: 'seite' });
    hoehePlanen();
    window.addEventListener('message', function (ev) {
      var d = ev.data;
      if (ev.source !== window.parent || !d || d.quelle !== 'woelfe-live' || d.typ !== 'sicht') return;
      var oben = Number(d.oben), hoehe = Number(d.hoehe);
      if (!isFinite(oben) || !isFinite(hoehe) || oben < 0 || hoehe < 100 || hoehe > 10000) return;
      var wurzel = document.documentElement;
      wurzel.style.setProperty('--sicht-oben', Math.round(oben) + 'px');
      wurzel.style.setProperty('--sicht-hoehe', Math.round(hoehe) + 'px');
      if (!wurzel.classList.contains('eingebettet')) wurzel.classList.add('eingebettet');
    });
  }

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
  if (farbeVorgabe) themeWahl = farbeVorgabe[1] === 'dunkel' ? 'dark' : 'light';
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
  var sortWahl = {};
  function sortierungEinrichten() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-sorttable]'), function (sortTabelle) {
    var abschnitt = sortTabelle.closest('section');
    var sortLeiste = abschnitt ? abschnitt.querySelector('[data-sortbar]') : null;
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
        if (b) { sortWahl[abschnitt.id] = b.getAttribute('data-sort'); sortieren(sortWahl[abschnitt.id]); }
      });
      if (sortWahl[abschnitt.id] && sortWahl[abschnitt.id] !== 'datum') sortieren(sortWahl[abschnitt.id]);
    }
  });
  }
  sortierungEinrichten();

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

  // Spielplan: Liste oder Monatskalender, filtern und zum nächsten Spiel springen.
  var filterWahl = 'alle';
  var ansicht = 'liste';
  try { if (localStorage.getItem('handball-site-ansicht') === 'kalender') ansicht = 'kalender'; } catch (e) {}
  var monatWahl = null;
  function monateZeigen() {
    var monate = Array.prototype.slice.call(document.querySelectorAll('#spielplan [data-monat]'));
    if (!monate.length) return;
    var vorhanden = monate.some(function (m) { return m.getAttribute('data-monat') === monatWahl; });
    if (!vorhanden) {
      var start = document.querySelector('#spielplan [data-monat][data-aktuell]') || monate[monate.length - 1];
      monatWahl = start.getAttribute('data-monat');
    }
    var idx = 0;
    monate.forEach(function (m, i) {
      var an = m.getAttribute('data-monat') === monatWahl;
      m.hidden = !an;
      if (an) {
        idx = i;
        m.querySelector('[data-monat-zurueck]').disabled = i === 0;
        m.querySelector('[data-monat-weiter]').disabled = i === monate.length - 1;
      }
    });
  }
  function planAnwenden() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-filter-bar]'), function (leiste) { leiste.hidden = false; });
    Array.prototype.forEach.call(document.querySelectorAll('#spielplan .plan li'), function (li) {
      li.hidden = !(filterWahl === 'alle' || li.getAttribute('data-ha') === filterWahl || li.getAttribute('data-st') === filterWahl);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-filter') === filterWahl ? 'true' : 'false');
    });
    var plan = document.getElementById('spielplan');
    if (plan) plan.setAttribute('data-ansicht', document.querySelector('#spielplan [data-kalender]') ? ansicht : 'liste');
    Array.prototype.forEach.call(document.querySelectorAll('[data-ansicht]'), function (b) {
      if (b.tagName !== 'BUTTON') return;
      b.hidden = !document.querySelector('#spielplan [data-kalender]');
      b.setAttribute('aria-pressed', b.getAttribute('data-ansicht') === ansicht ? 'true' : 'false');
    });
    monateZeigen();
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-filter],[data-jump],button[data-ansicht],[data-monat-zurueck],[data-monat-weiter]') : null;
    if (!t) return;
    if (t.hasAttribute('data-ansicht')) {
      ansicht = t.getAttribute('data-ansicht') === 'kalender' ? 'kalender' : 'liste';
      try { localStorage.setItem('handball-site-ansicht', ansicht); } catch (e) {}
      planAnwenden();
      return;
    }
    if (t.hasAttribute('data-monat-zurueck') || t.hasAttribute('data-monat-weiter')) {
      var monate = Array.prototype.slice.call(document.querySelectorAll('#spielplan [data-monat]'));
      var i = monate.findIndex(function (m) { return m.getAttribute('data-monat') === monatWahl; });
      var ziel = monate[i + (t.hasAttribute('data-monat-weiter') ? 1 : -1)];
      if (ziel) { monatWahl = ziel.getAttribute('data-monat'); monateZeigen(); }
      return;
    }
    if (t.hasAttribute('data-filter')) { filterWahl = t.getAttribute('data-filter'); planAnwenden(); return; }
    var next = document.querySelector('#spielplan .plan li.next');
    if (!next) return;
    if (next.hidden) { filterWahl = 'alle'; planAnwenden(); }
    next.scrollIntoView({ block: 'center' });
  });
  planAnwenden();

  // Gegner-Steckbrief: Ein Tipp auf eine Tabellenzeile öffnet ihn als Fenster (Enter und Leertaste auch).
  function steckbriefOeffnen(zeile) {
    var d = zeile && document.getElementById(zeile.getAttribute('data-sb'));
    if (!d) return;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }
  document.addEventListener('click', function (ev) {
    var z = ev.target && ev.target.closest ? ev.target.closest('tr[data-sb]') : null;
    if (z) steckbriefOeffnen(z);
    var d = ev.target;
    if (d && d.tagName === 'DIALOG' && d.classList.contains('steckbrief') && typeof d.close === 'function') d.close();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var z = ev.target && ev.target.closest ? ev.target.closest('tr[data-sb]') : null;
    if (!z) return;
    ev.preventDefault();
    steckbriefOeffnen(z);
  });

  // Kleiner Kopf, der mitläuft, sobald der große aus dem Bild ist: Mannschaft, Platz, nächstes Spiel, Weg nach oben.
  (function () {
    var mini = document.querySelector('[data-mini]');
    var hero = document.querySelector('.hero');
    if (!mini || !hero || !('IntersectionObserver' in window)) return;
    mini.hidden = false;
    var zeige = function (an) { mini.classList.toggle('sichtbar', an); if (an) mini.removeAttribute('inert'); else mini.setAttribute('inert', ''); };
    new IntersectionObserver(function (eintraege) { zeige(!eintraege[0].isIntersecting); }, { threshold: 0 }).observe(hero);
    var hoch = mini.querySelector('[data-nach-oben]');
    if (hoch) hoch.addEventListener('click', function () { window.scrollTo({ top: 0 }); });
  })();

  // Nebenabschnitte zunächst eingeklappt: eine Zeile Vorschau, ein Knopf zum Aufklappen. Der Zustand
  // bleibt je Abschnitt im Browser; ein Anker auf einen eingeklappten Abschnitt klappt ihn auf.
  function klappeSchluessel(sec) { return 'handball-site-klappe:' + sec.getAttribute('data-klappe'); }
  function klappeSetzen(sec, zu, merken) {
    sec.classList.toggle('zu', zu);
    var v = sec.querySelector(':scope > .vorschau');
    if (v) v.hidden = !zu;
    var knopf = sec.querySelector(':scope > h2 > .klappe');
    if (knopf) {
      knopf.setAttribute('aria-expanded', zu ? 'false' : 'true');
      knopf.textContent = sec.id === 'spielplan' ? (zu ? 'Ganzer Spielplan' : 'Kürzer') : (zu ? 'Aufklappen' : 'Zuklappen');
    }
    if (merken) { try { localStorage.setItem(klappeSchluessel(sec), zu ? 'zu' : 'auf'); } catch (e) {} }
  }
  function klappenAnwenden() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-klappe]'), function (sec) {
      var h2 = sec.querySelector(':scope > h2');
      if (h2 && !h2.querySelector('.klappe')) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'klappe';
        if (sec.id) b.setAttribute('aria-controls', sec.id);
        h2.appendChild(b);
      }
      var gemerkt = null;
      try { gemerkt = localStorage.getItem(klappeSchluessel(sec)); } catch (e) {}
      klappeSetzen(sec, gemerkt !== 'auf', false);
    });
    ankerOeffnen(location.hash);
  }
  function ankerOeffnen(hash) {
    if (!hash || hash.length < 2) return;
    var el = null;
    try { el = document.getElementById(decodeURIComponent(hash.slice(1))); } catch (e) {}
    var sec = el && el.closest ? el.closest('[data-klappe]') : null;
    if (sec && sec.classList.contains('zu')) klappeSetzen(sec, false, false);
  }
  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('.klappe, [data-klappe] > .vorschau, a[href^="#"]') : null;
    if (!t) return;
    if (t.tagName === 'A') { ankerOeffnen(t.getAttribute('href')); return; }
    var sec = t.closest('[data-klappe]');
    klappeSetzen(sec, !sec.classList.contains('zu'), true);
    if (sec.id === 'spielplan' && typeof planAnwenden === 'function') planAnwenden();
  });
  window.addEventListener('hashchange', function () { ankerOeffnen(location.hash); });
  klappenAnwenden();

  // Bereichskästen im Kopf: Die Liste liegt als Overlay über der Seite — ein Klick daneben oder Esc schließt sie.
  function kaestenSchliessen(ausser) {
    Array.prototype.forEach.call(document.querySelectorAll('details.kasten[open]'), function (d) { if (d !== ausser) d.open = false; });
  }
  document.addEventListener('click', function (ev) {
    kaestenSchliessen(ev.target && ev.target.closest ? ev.target.closest('details.kasten') : null);
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    var offen = document.querySelector('details.kasten[open]');
    if (!offen) return;
    offen.open = false;
    var s = offen.querySelector('summary');
    if (s) s.focus();
  });

  // Sprungleiste: klebt oben (unter dem Mini-Kopf, wenn der zu sehen ist) und markiert den Abschnitt, in dem man gerade liest.
  (function () {
    var leiste = document.querySelector('[data-sprung]');
    if (!leiste) return;
    var liste = leiste.querySelector('ul');
    var links = Array.prototype.slice.call(leiste.querySelectorAll('a[href^="#"]'));
    var mini = document.querySelector('[data-mini]');
    if (mini && 'IntersectionObserver' in window) document.documentElement.classList.add('mit-mini');
    var aktiv = null;
    var setzen = function (a) {
      if (a === aktiv) return;
      if (aktiv) aktiv.removeAttribute('aria-current');
      aktiv = a;
      if (!a) return;
      a.setAttribute('aria-current', 'true');
      var li = a.parentNode;
      if (li.offsetLeft < liste.scrollLeft || li.offsetLeft + li.offsetWidth > liste.scrollLeft + liste.clientWidth) liste.scrollLeft = li.offsetLeft - 16;
    };
    var markieren = function () {
      var oben = mini && mini.classList.contains('sichtbar') ? mini.offsetHeight : 0;
      document.documentElement.style.setProperty('--oben', oben + 'px');
      var grenze = oben + leiste.offsetHeight + 32;
      var treffer = null, bester = -Infinity;
      links.forEach(function (a) {
        var el = document.getElementById(a.getAttribute('href').slice(1));
        if (!el) return;
        var top = el.getBoundingClientRect().top;
        if (top <= grenze && top > bester) { bester = top; treffer = a; }
      });
      // Ganz unten zählt der letzte Abschnitt, auch wenn er nicht bis nach oben reicht.
      if (window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) treffer = links[links.length - 1];
      setzen(treffer);
    };
    var geplant = false;
    var spaeter = function () { if (geplant) return; geplant = true; requestAnimationFrame(function () { geplant = false; markieren(); }); };
    window.addEventListener('scroll', spaeter, { passive: true });
    window.addEventListener('resize', spaeter);
    links.forEach(function (a) { a.addEventListener('click', function () { setzen(a); }); });
    markieren();
  })();

  // Bilder laden mit einem ruhigen Platzhalter statt mit Alt-Text: Die Fläche schimmert, bis das Bild da ist; geht es schief, bleibt sie still und leer.
  // Den Schimmer schaltet erst dieses Skript ein (Klasse „laedt“) — ohne Skript läuft nichts endlos.
  Array.prototype.forEach.call(document.querySelectorAll('.card img.bild, .portraets img'), function (img) {
    var fertig = function () { img.classList.remove('laedt'); img.classList.add('fertig'); };
    var fehler = function () { img.classList.remove('laedt'); img.classList.add('fehler'); };
    if (img.complete) { if (img.naturalWidth > 0) fertig(); else fehler(); return; }
    img.classList.add('laedt');
    img.addEventListener('load', fertig);
    img.addEventListener('error', fehler);
  });

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
    // Alle laufenden Stände einer Seite: auf der Mannschaftsseite der eine, auf der Startseite einer je Mannschaft.
    var staende = function (wurzel) {
      var out = {};
      Array.prototype.forEach.call(wurzel.querySelectorAll('#naechstes [data-stand], #live [data-stand]'), function (el, i) {
        var m = /^(\\d+):(\\d+)$/.exec(el.getAttribute('data-stand') || '');
        // Der Stand steht klassisch als Heim:Gast; data-heim sagt, welche Seite die eigene ist.
        var heim = el.getAttribute('data-heim') !== '0';
        if (m) out[el.getAttribute('data-key') || String(i)] = { label: el.getAttribute('data-label') || '', eigene: heim ? +m[1] : +m[2], gegner: heim ? +m[2] : +m[1], text: m[0] };
      });
      return out;
    };
    // Was dieses Gerät meldet: Vibration an/aus und welche Mannschaften stumm sind — nur im Browser gemerkt.
    var merkLesen = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
    var merkSchreiben = function (k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };
    var vibrationAn = function () { return merkLesen('hb-vibration') !== 'aus'; };
    var stummeTeams = function () { return (merkLesen('hb-stumm') || '').split(',').filter(Boolean); };
    // Die Knöpfe tragen beide Zustände (Icon und Text) und zeigen den passenden.
    var zustand = function (b, an) {
      var x = b.querySelector('[data-an]'), y = b.querySelector('[data-aus]');
      if (x) x.hidden = !an;
      if (y) y.hidden = an;
    };
    var steuerungAnwenden = function () {
      var an = vibrationAn();
      var kannVibrieren = typeof navigator.vibrate === 'function';
      Array.prototype.forEach.call(document.querySelectorAll('[data-vibration]'), function (b) {
        b.hidden = !kannVibrieren;
        b.setAttribute('aria-pressed', an ? 'true' : 'false');
        zustand(b, an);
      });
      var stumm = stummeTeams();
      var knoepfe = document.querySelectorAll('[data-stumm]');
      Array.prototype.forEach.call(knoepfe, function (b) {
        var aus = stumm.indexOf(b.getAttribute('data-stumm')) >= 0;
        b.hidden = knoepfe.length < 2;
        b.setAttribute('aria-pressed', aus ? 'false' : 'true');
        zustand(b, !aus);
      });
      var stummHinweis = document.querySelector('[data-stumm-hinweis]');
      if (stummHinweis) stummHinweis.hidden = knoepfe.length < 2;
    };
    document.addEventListener('click', function (ev) {
      var ziel = ev.target && ev.target.closest ? ev.target.closest('[data-vibration], [data-stumm]') : null;
      if (!ziel) return;
      if (ziel.hasAttribute('data-vibration')) {
        merkSchreiben('hb-vibration', vibrationAn() ? 'aus' : null);
      } else {
        var id = ziel.getAttribute('data-stumm');
        var liste = stummeTeams();
        var pos = liste.indexOf(id);
        if (pos >= 0) liste.splice(pos, 1); else liste.push(id);
        merkSchreiben('hb-stumm', liste.length ? liste.join(',') : null);
      }
      steuerungAnwenden();
    });
    steuerungAnwenden();
    var torHinweis = function (alt, neu) {
      var zeilen = [];
      var eigenes = false;
      var stumm = stummeTeams();
      Object.keys(neu).forEach(function (k) {
        if (stumm.indexOf(k) >= 0) return;
        var a = alt[k], n = neu[k];
        if (!a || (a.eigene === n.eigene && a.gegner === n.gegner)) return;
        var tor = n.eigene > a.eigene;
        if (tor) eigenes = true;
        zeilen.push((tor ? 'Tor! ' : n.gegner > a.gegner ? 'Gegentor ' : 'Neuer Stand ') + (n.label ? n.label + ' ' : '') + n.text);
      });
      if (!zeilen.length) return;
      hinweis.textContent = zeilen.join(' · ');
      hinweis.hidden = false;
      clearTimeout(hinweisTimer);
      hinweisTimer = setTimeout(function () { hinweis.hidden = true; }, 6000);
      try { if (navigator.vibrate && vibrationAn()) navigator.vibrate(eigenes ? [120, 80, 120] : [220]); } catch (e) {}
    };
    // Der Stand im Tab-Titel: Wer in einem anderen Tab ist, sieht ihn in der Tab-Leiste.
    var titelOriginal = document.title;
    var titelSetzen = function () {
      var s = staende(document), k = Object.keys(s);
      document.title = k.length === 0 ? titelOriginal : k.length === 1 ? '● ' + s[k[0]].text + ' · ' + titelOriginal : '● ' + k.length + ' Spiele live · ' + titelOriginal;
    };
    titelSetzen();
    // PRF-4: Im Rahmen der Vereinsseite zählt auch, ob der Rahmen gerade zu sehen ist; weggescrollt ruht die Abfrage.
    var imBild = true;
    if (typeof IntersectionObserver === 'function') {
      new IntersectionObserver(function (eintraege) {
        var vorher = imBild;
        imBild = eintraege[eintraege.length - 1].isIntersecting;
        if (imBild && !vorher) liveHolen();
      }).observe(document.body);
    }
    var liveAus = false;
    var liveTakt = setInterval(function () { liveHolen(); }, 30000);
    function liveHolen() {
      if (liveAus || document.hidden || !imBild) return;
      // Bedingt nachfragen: Ohne neuen Stand antwortet der Server mit 304 statt der ganzen Seite (PRF-1-002).
      fetch(location.pathname + location.search, { cache: 'no-cache', credentials: 'omit' })
        .then(function (res) { return res.ok ? res.text() : null; })
        .then(function (html) {
          if (!html) return;
          var doc = new DOMParser().parseFromString(html, 'text/html');
          torHinweis(staende(document), staende(doc));
          var tickerOffen = !!document.querySelector('#naechstes details.ticker[open]');
          var saisonOffen = !!document.querySelector('#saison[open]');
          // Mannschaftsseite: Spiel, Letztes, Tabelle; Startseite: Läuft gerade, Heim- und Auswärtsspiele, Stand.
          ['naechstes', 'letztes', 'tabelle', 'live', 'heute', 'heimspiele', 'auswaertsspiele', 'letztes-wochenende', 'stand'].forEach(function (id) {
            var neu = doc.getElementById(id);
            var alt = document.getElementById(id);
            if (neu && alt) alt.replaceWith(neu);
            else if (alt && !neu && id === 'live') alt.remove();
          });
          if (document.querySelector('[data-sorttable]')) sortierungEinrichten();
          klappenAnwenden();
          var ticker = document.querySelector('#naechstes details.ticker');
          if (ticker && tickerOffen) ticker.open = true;
          var saison = document.querySelector('details#saison');
          if (saison && saisonOffen) saison.open = true;
          var kopfNeu = doc.querySelector('.hero .stats');
          var kopfAlt = document.querySelector('.hero .stats');
          if (kopfNeu && kopfAlt) kopfAlt.replaceWith(kopfNeu);
          var planNeu = doc.getElementById('spielplan');
          var planAlt = document.getElementById('spielplan');
          if (planNeu && planAlt && !planAlt.querySelector('details[open]')) { planAlt.replaceWith(planNeu); planAnwenden(); klappenAnwenden(); }
          countdown();
          steuerungAnwenden();
          titelSetzen();
          if (!doc.body.hasAttribute('data-live')) { document.body.removeAttribute('data-live'); liveAus = true; clearInterval(liveTakt); titelSetzen(); }
        })
        .catch(function () {});
    }
  }

  // Als App installieren. Im iFrame der Vereinsseite bietet kein Browser die Installation an:
  // Dort öffnet der Knopf die volle Seite in einem eigenen Tab (?installieren=1), und die
  // zeigt gleich das Fenster. Chrome und Co. melden mit beforeinstallprompt, dass sie
  // installieren können; Safari auf iPhone und iPad kann das nur über „Teilen“.
  var eingebettet = true;
  try { eingebettet = window.top !== window.self; } catch (e) {}
  var installKnopf = document.querySelector('[data-install]');
  var installFenster = document.getElementById('installieren');
  if (installKnopf && installFenster && document.querySelector('link[rel=manifest]')) {
    var installiert = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
    var apfel = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var angebot = null;
    var teil = function (name, an) { var el = installFenster.querySelector('[data-install-' + name + ']'); if (el) el.hidden = !an; };
    var installStand = function () {
      teil('prompt', !installiert && angebot !== null);
      teil('ios', !installiert && angebot === null && apfel);
      teil('menu', !installiert && angebot === null && !apfel);
      teil('done', installiert);
    };
    var installOeffnen = function () {
      installStand();
      if (typeof installFenster.showModal === 'function') installFenster.showModal(); else installFenster.setAttribute('open', '');
    };
    window.addEventListener('beforeinstallprompt', function (ev) {
      ev.preventDefault();
      angebot = ev;
      if (!eingebettet) installKnopf.hidden = false;
      installStand();
    });
    window.addEventListener('appinstalled', function () {
      angebot = null;
      installiert = true;
      installKnopf.hidden = true;
      installStand();
    });
    if (eingebettet || (apfel && !installiert)) installKnopf.hidden = false;
    installKnopf.addEventListener('click', function (ev) {
      if (eingebettet) return;
      ev.preventDefault();
      installOeffnen();
    });
    var installLos = installFenster.querySelector('[data-install-go]');
    if (installLos) installLos.addEventListener('click', function () {
      if (!angebot) return;
      var a = angebot;
      angebot = null;
      a.prompt();
      a.userChoice.then(function () { installStand(); if (typeof installFenster.close === 'function') installFenster.close(); }, function () {});
    });
    installFenster.addEventListener('click', function (ev) { if (ev.target === installFenster && typeof installFenster.close === 'function') installFenster.close(); });
    try {
      var hier = new URL(location.href);
      if (hier.searchParams.get('installieren') === '1' && !eingebettet) {
        hier.searchParams.delete('installieren');
        history.replaceState(null, '', hier.pathname + hier.search + hier.hash);
        installOeffnen();
      }
    } catch (e) {}
  }

  // Das Benachrichtigungsfenster: Die Glocke im Kopf öffnet es, ein Klick daneben oder Esc schließt es.
  var root = document.getElementById('push');
  if (!root) return;
  var glocke = document.querySelector('[data-dialog-open=push]');
  var pushOeffnen = function () {
    if (typeof root.showModal === 'function') root.showModal(); else root.setAttribute('open', '');
  };
  if (glocke) {
    glocke.hidden = false;
    // Im iFrame der Vereinsseite fragt kein Browser nach der Erlaubnis für Benachrichtigungen:
    // Dort öffnet die Glocke die volle Seite in einem eigenen Tab (?benachrichtigungen=1),
    // und die zeigt gleich das Fenster.
    glocke.addEventListener('click', function () {
      if (!eingebettet) { pushOeffnen(); return; }
      window.open(location.pathname + '?benachrichtigungen=1', '_blank', 'noopener');
    });
  }
  try {
    var seite = new URL(location.href);
    if (seite.searchParams.get('benachrichtigungen') === '1' && !eingebettet) {
      seite.searchParams.delete('benachrichtigungen');
      history.replaceState(null, '', seite.pathname + seite.search + seite.hash);
      pushOeffnen();
    }
  } catch (e) {}
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

  var club = root.getAttribute('data-scope') === 'club';
  var teamId = root.getAttribute('data-team') || '*';
  var PREFIX = 'handball-site-push:';
  var KEY = PREFIX + (club ? '*' : teamId);
  var leadBlock = form.querySelector('[data-lead]');
  var zusammen = form.querySelector('[data-zusammen]');
  function gemerkt() {
    try {
      // Ältere Fassungen merkten eine Wahl für alle Mannschaften unter einem Schlüssel.
      return JSON.parse(localStorage.getItem(KEY) || (club ? 'null' : localStorage.getItem('handball-site-push') || 'null'));
    } catch (e) { return null; }
  }
  function merken(v) {
    v.label = root.getAttribute('data-label') || '';
    try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {}
    andere();
  }
  function vergessen() { try { localStorage.removeItem(KEY); } catch (e) {} andere(); }
  // Was dieses Gerät sonst noch abonniert hat (jede Seite hat ihren eigenen Worker, also eine eigene Anmeldung).
  var andereZeile = root.querySelector('[data-andere]');
  function andere() {
    if (!andereZeile) return;
    var rest = [], hatVerein = false;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(PREFIX) !== 0 || k === KEY) continue;
        if (k === PREFIX + '*') { hatVerein = true; continue; }
        var w = JSON.parse(localStorage.getItem(k) || 'null');
        if (w && w.label) rest.push(w.label);
      }
    } catch (e) {}
    var text = '';
    if (club) {
      if (rest.length) text = 'Auf diesem Gerät zusätzlich eingeschaltet: ' + rest.join(', ') + '.';
    } else {
      if (hatVerein) text = 'Auf diesem Gerät sind schon alle Heimspiele des Vereins eingeschaltet. Hier lohnt sich vor allem das, was sie nicht abdecken: die Auswärtsspiele dieser Mannschaft.';
      if (rest.length) text += (text ? ' ' : '') + 'Außerdem eingeschaltet: ' + rest.join(', ') + '.';
    }
    andereZeile.textContent = text;
    andereZeile.hidden = !text;
  }
  andere();
  function boxen() { return Array.prototype.slice.call(form.querySelectorAll('input[name=thema]')); }
  function wahl() {
    var lead = form.querySelector('input[name=lead]:checked');
    var topics = boxen().filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
    return { lead: lead ? lead.value : '1h', topics: topics };
  }
  // Was man ankreuzt, in einem Satz — dasselbe, was die Bestätigung auf dem Gerät nennt.
  function satz(w) {
    var t = w.topics, n = [];
    if (t.indexOf('upcoming') >= 0) n.push(w.lead === 'abend' ? 'Ankündigung am Vorabend' : 'Ankündigung ' + (w.lead === '3h' ? '3 Stunden' : '1 Stunde') + ' vorher');
    if (t.indexOf('halftime') >= 0) n.push('Halbzeitstand');
    if (t.indexOf('result') >= 0) n.push('Endstand');
    if (t.indexOf('change') >= 0) n.push('Verlegungen und Absagen');
    if (t.indexOf('preview') >= 0) n.push('Wochenvorschau am Donnerstag');
    if (!n.length) return '';
    return n.length === 1 ? n[0] : n.slice(0, -1).join(', ') + ' und ' + n[n.length - 1];
  }
  function auffrischen() {
    var w = wahl();
    if (leadBlock) leadBlock.hidden = w.topics.indexOf('upcoming') < 0;
    zusammen.textContent = w.topics.length ? 'Du bekommst: ' + satz(w) + '.' : 'Nichts angekreuzt — so kommt nichts an.';
    btnOn.disabled = w.topics.length === 0;
  }
  form.addEventListener('change', auffrischen);
  function setzeWahl(v) {
    if (!v) { auffrischen(); return; }
    var l = form.querySelector('input[name=lead][value="' + v.lead + '"]');
    if (l) l.checked = true;
    // Ältere Fassungen merkten nur den Modus.
    var topics = v.topics || (v.mode === 'results' ? ['result', 'change'] : ['upcoming', 'halftime', 'result', 'change']);
    boxen().forEach(function (b) { b.checked = topics.indexOf(b.value) >= 0; });
    auffrischen();
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
      say('Eingeschaltet auf diesem Gerät: ' + (satz(wahl()) || 'nichts') + '.');
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
      auffrischen();
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
          body: JSON.stringify({ subscription: sub.toJSON(), lead: w.topics.indexOf('upcoming') >= 0 ? w.lead : 'aus', topics: w.topics })
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
    }).then(function () { vergessen(); zeige(null); say('Ausgeschaltet.'); }).catch(function () { say('Abmelden hat nicht geklappt.'); })
      .then(function () { btnOff.disabled = false; });
  });
})();
`;
