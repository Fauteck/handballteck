import { describe, it, expect } from 'vitest';
import { KONTRAST, siteCss } from '../lib/handballSiteAssets';
import { DEFAULT_PALETTE } from '../lib/handballTableImage';

/**
 * Kontrast der Microsite (WCAG 2.1 AA): Text mindestens 4,5:1, Linien und
 * Flächen mindestens 3:1 — im hellen und im dunklen Schema, mit den
 * Vereinsfarben der Wölfe. Gerechnet wird mit denselben Farbwerten, die das
 * Stylesheet ausgibt (`KONTRAST`), nicht mit einer Kopie. Andere Vereinsfarben
 * stellt das nicht sicher: `--ad` und `--a` kommen aus der Konfiguration.
 */

type Rgb = [number, number, number];
/** `#rrggbb` oder `#rgb` in Kanäle. */
const hex = (c: string): Rgb => {
  const voll = c.length === 4 ? `#${[...c.slice(1)].map(x => x + x).join('')}` : c;
  return [1, 3, 5].map(k => parseInt(voll.slice(k, k + 2), 16)) as Rgb;
};
const kanal = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const leuchtdichte = ([r, g, b]: Rgb) => 0.2126 * kanal(r) + 0.7152 * kanal(g) + 0.0722 * kanal(b);
const kontrast = (a: Rgb, b: Rgb) => { const [x, y] = [leuchtdichte(a), leuchtdichte(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mischen = (a: Rgb, b: Rgb, anteilA: number): Rgb => a.map((v, i) => Math.round(v * anteilA + b[i] * (1 - anteilA))) as Rgb;

const FARBEN: Record<string, Rgb> = {
  '--p': hex(DEFAULT_PALETTE.primary), '--a': hex(DEFAULT_PALETTE.accent), '--ad': hex(DEFAULT_PALETTE.accentDark),
  '--win': hex('#1f9d55'), '--loss': hex('#c9403a'),
};

/** `var(--x)`, `#rrggbb` oder `color-mix(in srgb,<Farbe> N%,<Farbe>)` in einen Wert auflösen. */
function aufloesen(ausdruck: string): Rgb {
  const t = ausdruck.trim();
  const v = /^var\((--[a-z]+)\)$/.exec(t);
  if (v) return FARBEN[v[1]];
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t)) return hex(t);
  const m = /^color-mix\(in srgb,(.+) (\d+)%,(.+)\)$/.exec(t);
  if (!m) throw new Error(`nicht auflösbar: ${ausdruck}`);
  return mischen(aufloesen(m[1]), aufloesen(m[3]), Number(m[2]) / 100);
}

const HELL = { card: hex('#ffffff'), bg: hex('#f2f6f7'), muted: hex('#5d7178') };
const DUNKEL = { card: hex('#12262c'), bg: hex('#0c1a1f'), muted: hex('#9bb0b6') };

describe('Kontrast der Microsite', () => {
  const paare: Array<[string, Rgb, Rgb, number]> = [
    ['hell: Link auf Karte', aufloesen(KONTRAST.hell.lk), HELL.card, 4.5],
    ['hell: Link auf Seitengrund', aufloesen(KONTRAST.hell.lk), HELL.bg, 4.5],
    ['hell: Überschrift auf Karte', aufloesen(KONTRAST.hell.hd), HELL.card, 4.5],
    ['hell: Sieg-Text auf Siegfläche', aufloesen(KONTRAST.hell.wint), mischen(FARBEN['--win'], hex('#ffffff'), 0.16), 4.5],
    ['hell: Niederlage-Text auf Niederlagefläche', aufloesen(KONTRAST.hell.losst), mischen(FARBEN['--loss'], hex('#ffffff'), 0.14), 4.5],
    ['hell: ▲ auf Karte', aufloesen(KONTRAST.hell.wint), HELL.card, 4.5],
    ['hell: ▼ auf Karte', aufloesen(KONTRAST.hell.losst), HELL.card, 4.5],
    ['hell: gedämpfter Text auf Karte', HELL.muted, HELL.card, 4.5],
    ['hell: gedämpfter Text auf Seitengrund', HELL.muted, HELL.bg, 4.5],
    ['dunkel: Link auf Karte', aufloesen(KONTRAST.dunkel.lk), DUNKEL.card, 4.5],
    ['dunkel: Überschrift auf Karte', aufloesen(KONTRAST.dunkel.hd), DUNKEL.card, 4.5],
    ['dunkel: Sieg-Text auf Siegfläche', aufloesen(KONTRAST.dunkel.wint), mischen(FARBEN['--win'], DUNKEL.card, 0.24), 4.5],
    ['dunkel: Niederlage-Text auf Niederlagefläche', aufloesen(KONTRAST.dunkel.losst), mischen(FARBEN['--loss'], DUNKEL.card, 0.22), 4.5],
    ['dunkel: ▲ auf Karte', aufloesen(KONTRAST.dunkel.wint), DUNKEL.card, 4.5],
    ['dunkel: ▼ auf Karte', aufloesen(KONTRAST.dunkel.losst), DUNKEL.card, 4.5],
    ['dunkel: gedämpfter Text auf Karte', DUNKEL.muted, DUNKEL.card, 4.5],
    // Die eigene Tabellenzeile: Akzentfläche zu 16 % unter dem Text (siehe `DUNKEL` im Stylesheet).
    ['dunkel: gedämpfter Text in der eigenen Tabellenzeile', DUNKEL.muted, mischen(FARBEN['--a'], DUNKEL.card, 0.16), 4.5],
    ['dunkel: Verlaufslinie auf Karte (Grafik)', aufloesen(KONTRAST.dunkel.hd), DUNKEL.card, 3],
  ];

  it.each(paare)('%s', (_name, vorn, hinten, soll) => {
    expect(kontrast(vorn, hinten)).toBeGreaterThanOrEqual(soll);
  });

  it('gibt die geprüften Farben im Stylesheet aus — hell im Wurzelblock, dunkel im Schema', () => {
    const css = siteCss({ ...DEFAULT_PALETTE });
    for (const [k, v] of Object.entries(KONTRAST.hell)) expect(css).toContain(`--${k}:${v}`);
    for (const [k, v] of Object.entries(KONTRAST.dunkel)) expect(css).toContain(`--${k}:${v}`);
    expect(css).toContain('color-mix(in srgb,var(--a) 16%,#12262c)');
    // Keine Überschrift und keine Platznummer mehr in der Rohfarbe — die verschwindet im Dunklen.
    expect(css).toMatch(/h2\{[^}]*color:var\(--hd\)/);
    expect(css).toMatch(/td\.pos\{[^}]*color:var\(--hd\)/);
    expect(css).toMatch(/\ba\{color:var\(--lk\)\}/);
  });
});

describe('Tippflächen der Microsite', () => {
  const css = siteCss({ ...DEFAULT_PALETTE });
  const regel = (selektor: string) => {
    const i = css.indexOf(`${selektor}{`);
    expect(i, selektor).toBeGreaterThanOrEqual(0);
    return css.slice(i, css.indexOf('}', i));
  };

  it.each(['.btn', '.filter button', '.opts label', '.channel summary', 'details.more summary'])('%s ist mindestens 44 px hoch', selektor => {
    expect(regel(selektor)).toContain('min-height:44px');
  });

  it('macht Farbschalter, Feed-Knöpfe und Teamwahl (Touch) groß genug', () => {
    expect(regel('.hero .theme')).toMatch(/width:44px;height:44px/);
    expect(regel('.channel a.open,.channel button.open')).toContain('min-height:44px');
    expect(css).toMatch(/@media \(pointer:coarse\)\{[^}]*\.teamwahl a[^}]*min-height:44px/);
  });
});
