/**
 * Der eine Zwischenspeicher für alle gerasterten Bilder — Microsite, `/api`,
 * Inline-Modus und Bot (ARC-3-001). Vorher renderte nur die Seite mit Cache,
 * die drei anderen Wege je Aufruf neu, und gleichzeitige Anfragen für dasselbe
 * Bild renderten parallel.
 *
 * Zwei Schlüssel:
 * - **Inhalt:** Format, Maßstab und Hash des SVG. Dasselbe SVG ergibt dasselbe
 *   Bild, gleich wer es anfragt; ein neuer Stand ist ein neues SVG.
 * - **Kurzweg** (optional): z. B. Mannschaft, Bildart und Stand. Er zeigt auf
 *   einen Inhaltsschlüssel und spart das Bauen des SVG, solange der Stand gilt.
 *
 * Gleichzeitige Anfragen nach demselben Inhalt warten auf ein Rendering
 * (PRF-2-002). Gedeckelt nach Bytes, nicht nach Anzahl (die PNGs liegen
 * zwischen 100 KB und 1 MB); verdrängt wird, was am längsten nicht gelesen
 * wurde.
 */
import crypto from 'node:crypto';
import { renderPng, renderJpeg } from './handballTableImage';
import { konfigurationsStand } from '../config';

const MAX_BYTES = 24 * 1024 * 1024;
const FRIST_MS = 10 * 60 * 1000;
/** Mehr Kurzwege als Bilder, aber nicht beliebig viele — jeder neue Stand legt einen an. */
const MAX_KURZWEGE = 1000;

type Eintrag = { at: number; frist: number; bild: Buffer };
const eintraege = new Map<string, Eintrag>();
let belegt = 0;
const unterwegs = new Map<string, Promise<Buffer | null>>();
const kurzwege = new Map<string, string>();

function hash(text: string): string {
  return crypto.createHash('sha1').update(text).digest('base64url');
}

function entfernen(key: string): void {
  const e = eintraege.get(key);
  if (!e) return;
  eintraege.delete(key);
  belegt -= e.bild.length;
}

function ablegen(key: string, bild: Buffer, frist: number): void {
  entfernen(key);
  eintraege.set(key, { at: Date.now(), frist, bild });
  belegt += bild.length;
  // Map hält die Einfügereihenfolge; vorn steht, was am längsten nicht gelesen wurde.
  for (const aeltester of eintraege.keys()) {
    if (belegt <= MAX_BYTES || eintraege.size <= 1) break;
    entfernen(aeltester);
  }
}

function lesen(key: string): Buffer | undefined {
  const e = eintraege.get(key);
  if (!e) return undefined;
  const alter = Date.now() - e.at;
  if (alter < 0 || alter >= e.frist) { entfernen(key); return undefined; }
  eintraege.delete(key);
  eintraege.set(key, e);
  return e.bild;
}

/**
 * Das Bild unter `key` — aus dem Speicher, aus einem schon laufenden Aufbau
 * oder neu von `bauen`. `null` von `bauen` heißt „nichts zu zeichnen“ und
 * wird nicht gespeichert.
 */
export function zwischengespeichert(key: string, bauen: () => Promise<Buffer | null>, frist = FRIST_MS): Promise<Buffer | null> {
  const treffer = lesen(key);
  if (treffer) return Promise.resolve(treffer);
  const laufend = unterwegs.get(key);
  if (laufend) return laufend;
  const p = (async () => {
    try {
      const bild = await bauen();
      if (bild) ablegen(key, bild, frist);
      return bild;
    } finally {
      unterwegs.delete(key);
    }
  })();
  unterwegs.set(key, p);
  return p;
}

type Format = 'png' | 'jpeg';

function inhaltsSchluessel(format: Format, scale: number, svg: string): string {
  return `${format}:${scale}:${hash(svg)}`;
}

function rastern(format: Format, scale: number, svg: string): Promise<Buffer> {
  return format === 'png' ? renderPng(svg, scale) : renderJpeg(svg, scale);
}

/** Ein SVG als PNG (Standard: doppelt gerastert, 1600 px). */
export async function svgAlsPng(svg: string, scale = 2): Promise<Buffer> {
  return (await zwischengespeichert(inhaltsSchluessel('png', scale, svg), () => rastern('png', scale, svg)))!;
}

/** Ein SVG als JPEG — für den Inline-Modus, der nur JPEG annimmt. */
export async function svgAlsJpeg(svg: string, scale = 2): Promise<Buffer> {
  return (await zwischengespeichert(inhaltsSchluessel('jpeg', scale, svg), () => rastern('jpeg', scale, svg)))!;
}

/**
 * Wie `svgAlsPng`/`svgAlsJpeg`, aber mit Kurzweg: Gilt `kurzweg` noch und
 * liegt sein Bild im Speicher, wird das SVG gar nicht erst gebaut.
 * `svgBauen` liefert null, wenn es nichts zu zeichnen gibt.
 */
export async function bildMitKurzweg(kurzweg: string, svgBauen: () => Promise<string | null> | string | null, format: Format = 'png', scale = 2): Promise<Buffer | null> {
  const weg = `${format}:${scale}:${kurzweg}`;
  const ziel = kurzwege.get(weg);
  if (ziel) {
    const treffer = lesen(ziel);
    if (treffer) return treffer;
    kurzwege.delete(weg);
  }
  // Auch das SVG nur einmal bauen, wenn viele gleichzeitig nach demselben Kurzweg fragen.
  const laufend = unterwegs.get(`weg:${weg}`);
  if (laufend) return laufend;
  const p = (async () => {
    try {
      const svg = await svgBauen();
      if (!svg) return null;
      const key = inhaltsSchluessel(format, scale, svg);
      const bild = await zwischengespeichert(key, () => rastern(format, scale, svg));
      if (kurzwege.size >= MAX_KURZWEGE) kurzwege.clear();
      kurzwege.set(weg, key);
      return bild;
    } finally {
      unterwegs.delete(`weg:${weg}`);
    }
  })();
  unterwegs.set(`weg:${weg}`, p);
  return p;
}

const staende = new WeakMap<object, string>();

/**
 * Der Stand einer Mannschaft für den Kurzweg ihrer Bilder: ein Hash ihrer
 * Sicht und der Konfiguration. Vorher galt `updated_at` der ganzen Übersicht —
 * jeder Live-Takt irgendeiner Mannschaft machte damit die Bilder aller
 * ungültig (PRF-2-002). Die Sicht ist zwischengespeichert und eingefroren,
 * deshalb wird der Hash je Objekt einmal gerechnet.
 */
export function standVon(sicht: object): string {
  let s = staende.get(sicht);
  if (s === undefined) {
    s = hash(JSON.stringify(sicht));
    staende.set(sicht, s);
  }
  return `${s}.${hash(konfigurationsStand())}`;
}

/** Nur für Tests. */
export function leereBildCache(): void {
  eintraege.clear();
  kurzwege.clear();
  belegt = 0;
}

/** Nur für Tests und `/api/health`: wie viel der Speicher gerade hält. */
export function bildCacheStand(): { bilder: number; bytes: number } {
  return { bilder: eintraege.size, bytes: belegt };
}
