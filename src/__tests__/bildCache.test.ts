import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * Der gemeinsame Zwischenspeicher der Bilder (ARC-3-001, PRF-2-002, PRF-2-005):
 * dasselbe SVG wird einmal gerastert, auch wenn viele gleichzeitig fragen;
 * ein gültiger Kurzweg spart das SVG; gedeckelt nach Bytes.
 */

const renderPng = vi.fn();
const renderJpeg = vi.fn();
vi.mock('../lib/handballTableImage', () => ({
  renderPng: (...a: unknown[]) => renderPng(...a),
  renderJpeg: (...a: unknown[]) => renderJpeg(...a),
}));

let cache: typeof import('../lib/bildCache');
beforeAll(async () => { cache = await import('../lib/bildCache'); });

beforeEach(() => {
  cache.leereBildCache();
  renderPng.mockReset();
  renderJpeg.mockReset();
  renderPng.mockImplementation(async (svg: string) => {
    await new Promise(r => setTimeout(r, 20));
    return Buffer.from(`png:${svg}`);
  });
  renderJpeg.mockImplementation(async (svg: string, scale: number) => Buffer.from(`jpg:${scale}:${svg}`));
});

describe('Bild-Zwischenspeicher', () => {
  it('rastert für acht gleichzeitige Anfragen dasselbe SVG genau einmal', async () => {
    const bilder = await Promise.all(Array.from({ length: 8 }, () => cache.svgAlsPng('<svg>tabelle</svg>')));
    expect(renderPng).toHaveBeenCalledTimes(1);
    expect(new Set(bilder.map(b => b.toString())).size).toBe(1);
    // Danach aus dem Speicher.
    await cache.svgAlsPng('<svg>tabelle</svg>');
    expect(renderPng).toHaveBeenCalledTimes(1);
  });

  it('trennt Format und Maßstab', async () => {
    await cache.svgAlsJpeg('<svg/>', 2);
    await cache.svgAlsJpeg('<svg/>', 0.4);
    await cache.svgAlsPng('<svg/>');
    expect(renderJpeg).toHaveBeenCalledTimes(2);
    expect(renderPng).toHaveBeenCalledTimes(1);
  });

  it('baut mit gültigem Kurzweg kein SVG; ein neuer Stand baut neu', async () => {
    const svg = vi.fn(() => '<svg>a</svg>');
    await cache.bildMitKurzweg('seite:1:tabelle:s1', svg);
    await cache.bildMitKurzweg('seite:1:tabelle:s1', svg);
    expect(svg).toHaveBeenCalledTimes(1);
    expect(renderPng).toHaveBeenCalledTimes(1);
    // Neuer Stand, gleiches SVG: das SVG wird gebaut, gerastert aber nicht.
    await cache.bildMitKurzweg('seite:1:tabelle:s2', svg);
    expect(svg).toHaveBeenCalledTimes(2);
    expect(renderPng).toHaveBeenCalledTimes(1);
  });

  it('baut für gleichzeitige Anfragen nach demselben Kurzweg das SVG einmal', async () => {
    const svg = vi.fn(async () => { await new Promise(r => setTimeout(r, 10)); return '<svg>k</svg>'; });
    await Promise.all(Array.from({ length: 8 }, () => cache.bildMitKurzweg('seite:1:kader:s1', svg)));
    expect(svg).toHaveBeenCalledTimes(1);
    expect(renderPng).toHaveBeenCalledTimes(1);
  });

  it('trennt auch im Kurzweg Format und Maßstab — die Vorschau ist nicht das große Bild', async () => {
    const svg = () => '<svg>inline</svg>';
    const gross = await cache.bildMitKurzweg('inline:1:tabelle:s1', svg, 'jpeg', 2);
    const klein = await cache.bildMitKurzweg('inline:1:tabelle:s1', svg, 'jpeg', 0.4);
    expect(gross!.toString()).toContain('jpg:2:');
    expect(klein!.toString()).toContain('jpg:0.4:');
  });

  it('speichert „nichts zu zeichnen“ nicht', async () => {
    const svg = vi.fn(() => null);
    expect(await cache.bildMitKurzweg('x', svg)).toBeNull();
    expect(await cache.bildMitKurzweg('x', svg)).toBeNull();
    expect(svg).toHaveBeenCalledTimes(2);
  });

  it('hält höchstens 24 MB und verdrängt, was am längsten nicht gelesen wurde', async () => {
    renderPng.mockImplementation(async () => Buffer.alloc(5 * 1024 * 1024));
    for (let i = 0; i < 6; i++) await cache.svgAlsPng(`<svg>${i}</svg>`);
    const stand = cache.bildCacheStand();
    expect(stand.bytes).toBeLessThanOrEqual(24 * 1024 * 1024);
    expect(stand.bilder).toBe(4);
    // Das erste ist verdrängt und wird neu gerastert, das letzte nicht.
    renderPng.mockClear();
    await cache.svgAlsPng('<svg>5</svg>');
    expect(renderPng).not.toHaveBeenCalled();
    await cache.svgAlsPng('<svg>0</svg>');
    expect(renderPng).toHaveBeenCalledTimes(1);
  });

  it('gibt einer unveränderten Sicht denselben Stand, einer geänderten einen neuen', () => {
    const a = Object.freeze({ team_id: '1', matches: [] });
    const b = Object.freeze({ team_id: '1', matches: [{ score_home: 1 }] });
    expect(cache.standVon(a)).toBe(cache.standVon(a));
    expect(cache.standVon(a)).not.toBe(cache.standVon(b));
  });
});
