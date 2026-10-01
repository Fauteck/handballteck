/**
 * Fotos von der Vereinsseite bei ClubDesk: das Gruppenbild je Mannschaft
 * (Übersicht „Teams & Tabellen") und bei den Senioren die Porträts aus dem
 * Kader der Teamseite. Seit Oktober 2026, vorerst **nur in der Vorschau** der
 * Seite (`SITE_PREVIEW_TOKEN`), bis die Bildrechte mit dem Verein geklärt sind.
 *
 * Was man über die Quelle wissen muss (geprüft am 01.10.2026):
 * - Bilder gibt es nur über `/clubdesk/fileservlet?type=image&id=…&s=…`; ohne
 *   die Signatur `s` antwortet ClubDesk mit 404. Die Signatur steht im HTML.
 * - Das Gruppenbild ist das Original — 6250 × 4419 px, 55 MB als PNG. Eine
 *   kleinere Fassung liefert ClubDesk dafür nicht (`imageFormat` wird
 *   übergangen). Deshalb: einmal laden, verkleinern, als JPEG ablegen, und
 *   nur neu laden, wenn sich ID oder Signatur ändern.
 * - Porträts gibt es in `_512x512` (rund 230 KB); die genügen.
 *
 * Abgerufen wird einmal am Tag, nach bestem Bemühen: Was scheitert, bleibt
 * beim alten Stand und meldet sich im Log — der Abruf von handball.net hängt
 * nicht daran. Jugendbilder werden nur mit `SITE_PLAYERS` überhaupt geholt,
 * Porträts nur für Senioren.
 */

import sharp from 'sharp';
import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '../db';
import { clubdesk_photo } from '../db/schema';
import { clubdeskUrl, clubdeskTeams, sitePlayers } from '../config';
import { safeFetchHtml, safeFetchImage } from './safeFetch';
import { serviceLog } from './serviceLogger';

/** Die Seiten liegen unter diesem Pfad; die Teamseiten darunter je Mannschaft. */
const TEAMS_PFAD = '/spielbetrieb/teams-und-tabellen';
/** Das Gruppenbild-Original ist bis zu 55 MB groß — mit Luft. */
const GRUPPE_MAX_BYTES = 80 * 1024 * 1024;
const PORTRAET_MAX_BYTES = 3 * 1024 * 1024;
const GRUPPE_BREITE = 1600;
const PORTRAET_BREITE = 400;
/** Ein Lauf am Tag genügt — die Bilder ändern sich zur Saison, nicht stündlich. */
const ABRUF_ABSTAND_MS = 20 * 60 * 60 * 1000;
/** Ein Bildpfad, wie ClubDesk ihn schreibt — alles andere wird nicht geladen. */
const BILD_SRC = /^fileservlet\?type=image&id=(\d{1,12})&s=([A-Za-z0-9_=-]{8,200})(?:&imageFormat=_\d{2,4}x\d{2,4})?$/;

export interface ClubdeskGruppe {
  slug: string;
  caption: string;
  imageId: string;
  signature: string;
}

export interface ClubdeskPerson {
  contactId: string;
  name: string;
  /** Die Überschrift des Abschnitts: „Trainer(in)", „Spieler(in)", „Torwart", „Offizielle" … */
  section: string;
  position: string | null;
  imageId: string | null;
  signature: string | null;
}

function text(roh: string): string {
  return roh
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&([aou])uml;/gi, (_, v: string) => ({ a: 'ä', o: 'ö', u: 'ü', A: 'Ä', O: 'Ö', U: 'Ü' } as Record<string, string>)[v])
    .replace(/&szlig;/g, 'ß')
    .replace(/\s+/g, ' ')
    .trim();
}

function bildAus(src: string): { imageId: string; signature: string } | null {
  const m = BILD_SRC.exec(src.replace(/&amp;/g, '&'));
  return m ? { imageId: m[1], signature: m[2] } : null;
}

/** Die Übersicht „Teams & Tabellen": je Teamseite ihr Gruppenbild samt Bildunterschrift. */
export function parseUebersicht(html: string): ClubdeskGruppe[] {
  const out: ClubdeskGruppe[] = [];
  const muster = /<a href="[^"]*\/teams-und-tabellen\/([a-z0-9_-]{1,40})"\s*>\s*<img[^>]*?src="([^"]+)"[^>]*>([\s\S]{0,400}?)<\/a>/gi;
  for (const m of html.matchAll(muster)) {
    const bild = bildAus(m[2]);
    if (!bild) continue;
    const caption = /class="cd-image-caption"[^>]*>([\s\S]*?)<\/p>/.exec(m[3]);
    out.push({ slug: m[1], caption: caption ? text(caption[1]) : m[1], ...bild });
  }
  return out;
}

/**
 * Die Teamseite: die Kacheln des Kaders, nach Abschnitt. Eine Kachel trägt
 * Kontakt-ID, Foto (nicht immer), Namen und Angaben wie „Position".
 */
export function parseTeamseite(html: string): ClubdeskPerson[] {
  const out: ClubdeskPerson[] = [];
  const abschnitte = html.split(/<h3[^>]*>/i).slice(1);
  for (const abschnitt of abschnitte) {
    const ende = abschnitt.indexOf('</h3>');
    if (ende < 0) continue;
    const section = text(abschnitt.slice(0, ende));
    const kacheln = abschnitt.slice(ende).split(/class="cd-tile-v-box\b/).slice(1);
    for (const k of kacheln) {
      const contact = /contact-(\d{1,12})"/.exec(k)?.[1];
      const name = /cd-tile-v-main-heading"[^>]*>([\s\S]*?)<\/div>/.exec(k)?.[1];
      if (!contact || !name || !text(name)) continue;
      const src = /<img[^>]*?src="([^"]+)"[^>]*alt="Kontaktfoto"/.exec(k)?.[1];
      const bild = src ? bildAus(src) : null;
      let position: string | null = null;
      for (const d of k.matchAll(/cd-tile-v-detail-label"[^>]*>([\s\S]*?)<\/div>\s*<div class="cd-tile-v-detail-value"[^>]*>([\s\S]*?)<\/div>/g)) {
        if (text(d[1]) === 'Position') position = text(d[2]) || null;
      }
      out.push({ contactId: contact, name: text(name), section, position, imageId: bild?.imageId ?? null, signature: bild?.signature ?? null });
    }
  }
  return out;
}

/** Ob eine Mannschaft eine Jugend ist — aus ihrem Namen in der Mannschaftswahl oder der Bildunterschrift der Vereinsseite. */
export function istJugend(...namen: Array<string | null | undefined>): boolean {
  return namen.some(n => !!n && /jugend|junior/i.test(n));
}

// ---------------------------------------------------------------------------
// Abruf
// ---------------------------------------------------------------------------

let letzterAbruf = 0;

/** Nur für Tests. */
export function __resetClubdeskForTests(): void {
  letzterAbruf = 0;
}

function bildUrl(basis: string, imageId: string, signature: string, format: string | null): string {
  return `${basis}/clubdesk/fileservlet?type=image&id=${imageId}&s=${encodeURIComponent(signature)}${format ? `&imageFormat=${format}` : ''}`;
}

function gespeicherterSchluessel(id: string): string | null {
  return db.select({ k: clubdesk_photo.source_key }).from(clubdesk_photo).where(eq(clubdesk_photo.id, id)).get()?.k ?? null;
}

async function alsJpeg(roh: Buffer, breite: number): Promise<Buffer> {
  return sharp(roh, { limitInputPixels: 120_000_000 })
    .rotate()
    .resize({ width: breite, withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
}

export interface ClubdeskAbruf {
  status: 'aus' | 'nicht_faellig' | 'ok' | 'fehler';
  geladen: number;
  detail?: string;
}

/**
 * Ein Abruf: Übersicht lesen, je eingetragener Mannschaft das Gruppenbild
 * (Jugend nur mit `SITE_PLAYERS`) und bei Senioren die Porträts. Geladen wird
 * nur, was neu ist oder sich geändert hat; wer von der Teamseite
 * verschwunden ist, fliegt raus. `force` überspringt den Tagesabstand.
 */
export async function clubdeskHolen(teamLabels: Map<string, string>, force = false, now = Date.now()): Promise<ClubdeskAbruf> {
  const basis = clubdeskUrl();
  const zuordnung = clubdeskTeams();
  if (!basis || zuordnung.size === 0) return { status: 'aus', geladen: 0 };
  if (!force && now - letzterAbruf < ABRUF_ABSTAND_MS) return { status: 'nicht_faellig', geladen: 0 };
  letzterAbruf = now;
  const host = new URL(basis).hostname;
  const nurHost = (u: URL) => u.hostname === host;
  let geladen = 0;
  try {
    const gruppen = parseUebersicht(await safeFetchHtml(`${basis}${TEAMS_PFAD}`, { allowHost: nurHost }));
    for (const [teamId, slug] of zuordnung) {
      const gruppe = gruppen.find(g => g.slug === slug) ?? null;
      const jugend = istJugend(teamLabels.get(teamId), gruppe?.caption);
      if (jugend && !sitePlayers()) {
        // Jugendbilder nur mit SITE_PLAYERS — und dann auch nicht vorhalten.
        db.delete(clubdesk_photo).where(eq(clubdesk_photo.team_id, teamId)).run();
        continue;
      }
      if (gruppe) {
        const id = `${teamId}:gruppe`;
        const schluessel = `${gruppe.imageId}:${gruppe.signature}`;
        if (gespeicherterSchluessel(id) !== schluessel) {
          try {
            const bild = await safeFetchImage(bildUrl(basis, gruppe.imageId, gruppe.signature, null), { allowHost: nurHost, maxBytes: GRUPPE_MAX_BYTES, timeoutMs: 90_000 });
            const jpeg = await alsJpeg(bild.buffer, GRUPPE_BREITE);
            speichern({ id, team_id: teamId, kind: 'gruppe', contact_id: null, name: gruppe.caption, section: null, position: null, sort: 0, source_key: schluessel, image: jpeg });
            geladen++;
          } catch (err) {
            serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, `[clubdesk] Gruppenbild für Team ${teamId} nicht abrufbar`);
          }
        }
      }
      if (jugend) continue;
      // Porträts nur bei Senioren.
      try {
        const personen = parseTeamseite(await safeFetchHtml(`${basis}${TEAMS_PFAD}/${slug}`, { allowHost: nurHost }));
        const behalten: string[] = [`${teamId}:gruppe`];
        let sort = 0;
        for (const p of personen) {
          sort++;
          if (!p.imageId || !p.signature) continue;
          const id = `${teamId}:person:${p.contactId}`;
          behalten.push(id);
          const schluessel = `${p.imageId}:${p.signature}`;
          if (gespeicherterSchluessel(id) === schluessel) {
            // Bild unverändert — Name, Abschnitt und Reihenfolge trotzdem nachziehen.
            db.update(clubdesk_photo).set({ name: p.name, section: p.section, position: p.position, sort }).where(eq(clubdesk_photo.id, id)).run();
            continue;
          }
          try {
            const bild = await safeFetchImage(bildUrl(basis, p.imageId, p.signature, '_512x512'), { allowHost: nurHost, maxBytes: PORTRAET_MAX_BYTES });
            const jpeg = await alsJpeg(bild.buffer, PORTRAET_BREITE);
            speichern({ id, team_id: teamId, kind: 'person', contact_id: p.contactId, name: p.name, section: p.section, position: p.position, sort, source_key: schluessel, image: jpeg });
            geladen++;
          } catch (err) {
            serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, `[clubdesk] Porträt ${p.contactId} (Team ${teamId}) nicht abrufbar`);
          }
        }
        // Wer nicht mehr auf der Teamseite steht, verschwindet auch hier.
        db.delete(clubdesk_photo).where(and(eq(clubdesk_photo.team_id, teamId), eq(clubdesk_photo.kind, 'person'), notInArray(clubdesk_photo.id, behalten))).run();
      } catch (err) {
        serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, `[clubdesk] Teamseite ${slug} nicht abrufbar`);
      }
    }
    // Mannschaften, die aus CLUBDESK_TEAMS verschwunden sind, nicht weiter vorhalten.
    db.delete(clubdesk_photo).where(notInArray(clubdesk_photo.team_id, [...zuordnung.keys()])).run();
    return { status: 'ok', geladen };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    serviceLog.warn({ err: detail }, '[clubdesk] Übersicht nicht abrufbar');
    return { status: 'fehler', geladen, detail };
  }
}

function speichern(z: Omit<typeof clubdesk_photo.$inferInsert, 'fetched_at'>): void {
  const fetched_at = new Date().toISOString();
  db.insert(clubdesk_photo).values({ ...z, fetched_at })
    .onConflictDoUpdate({ target: clubdesk_photo.id, set: { ...z, fetched_at } })
    .run();
}

// ---------------------------------------------------------------------------
// Lesen für die Seite
// ---------------------------------------------------------------------------

export interface ClubdeskPersonView {
  contactId: string;
  name: string;
  section: string;
  position: string | null;
}

export function hatGruppenbild(teamId: string): boolean {
  return !!db.select({ id: clubdesk_photo.id }).from(clubdesk_photo).where(eq(clubdesk_photo.id, `${teamId}:gruppe`)).get();
}

/** Die Porträts einer Mannschaft in der Reihenfolge der Vereinsseite. */
export function portraits(teamId: string): ClubdeskPersonView[] {
  return db.select({ contactId: clubdesk_photo.contact_id, name: clubdesk_photo.name, section: clubdesk_photo.section, position: clubdesk_photo.position, sort: clubdesk_photo.sort })
    .from(clubdesk_photo).where(and(eq(clubdesk_photo.team_id, teamId), eq(clubdesk_photo.kind, 'person'))).all()
    .sort((a, b) => a.sort - b.sort)
    .map(r => ({ contactId: r.contactId ?? '', name: r.name ?? '', section: r.section ?? '', position: r.position }));
}

/** Das JPEG eines Fotos — `gruppe` oder die Kontakt-ID eines Porträts; null, wenn es keins gibt. */
export function fotoJpeg(teamId: string, wer: string): Buffer | null {
  const id = wer === 'gruppe' ? `${teamId}:gruppe` : `${teamId}:person:${wer}`;
  return db.select({ image: clubdesk_photo.image }).from(clubdesk_photo).where(eq(clubdesk_photo.id, id)).get()?.image ?? null;
}
