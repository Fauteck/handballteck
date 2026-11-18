/**
 * Fotos von der Vereinsseite bei ClubDesk: das Gruppenbild je Mannschaft
 * (Übersicht „Teams & Tabellen") und bei den Senioren die Porträts aus dem
 * Kader der Teamseite. In der Vorschau (`SITE_PREVIEW_TOKEN`) immer; öffentlich
 * je Mannschaft nach Freigabe auf der Einstellungsseite (`SITE_PHOTOS`).
 * Warum und welche Freigaben: Wiki „Handball-Verfolgung (handball.net)“ §7.7.
 *
 * Zwei Arten von Seiten (`CLUBDESK_TEAMS`):
 * - `woelfe_1`: eine Teamseite unter „Teams & Tabellen“; das Gruppenbild steht
 *   in der Übersicht, der Kader mit `<h3>`-Abschnitten auf der Teamseite.
 * - `kinderhandball:1000129`: eine Gruppe auf einer Seite mit Gruppenkacheln
 *   (geprüft am 18.11.2026). Die Kachel trägt Gruppenbild und Namen und führt
 *   per `onclick` auf die Detailseite `?b=…&c=GD<gruppe>&s=…` (signiert, die
 *   Adresse wird deshalb jedes Mal aus der Kachel gelesen). Dort stehen die
 *   Kontakte als Kacheln, die Rolle („Trainer(in)“, „Spieler(in)“) als
 *   Untertitel. Solche Gruppen gelten immer als Jugend.
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
 * nicht daran. Jugendbilder werden nur mit Freigabe
 * überhaupt geholt, Jugend-Porträts nur mit Freigabe der Spielerbilder.
 */

import sharp from 'sharp';
import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '../db';
import { clubdesk_photo } from '../db/schema';
import { clubdeskUrl, clubdeskTeams, sitePhotos } from '../config';
import { safeFetchHtml, safeFetchImage } from './safeFetch';
import { serviceLog } from './serviceLogger';

/** Die Seiten liegen unter diesem Pfad; die Teamseiten darunter je Mannschaft. */
const TEAMS_PFAD = '/spielbetrieb/teams-und-tabellen';
/** Seiten mit Gruppenkacheln (Kinderhandball) liegen direkt unter diesem Pfad. */
const SPIELBETRIEB_PFAD = '/spielbetrieb';
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

export interface ClubdeskGruppenKachel {
  groupId: string;
  name: string;
  /** Pfad samt Abfrage der Detailseite, wie die Kachel ihn nennt (signiert). */
  detailPfad: string;
  imageId: string | null;
  signature: string | null;
}

/**
 * Eine Seite mit Gruppenkacheln (`/spielbetrieb/kinderhandball`): je Kachel
 * Gruppe, Name, Gruppenbild (fehlt beim Platzhalter) und die Detailseite.
 * Nur Detailseiten unter derselben Seite werden übernommen.
 */
export function parseGruppenkacheln(html: string, seite: string): ClubdeskGruppenKachel[] {
  const out: ClubdeskGruppenKachel[] = [];
  const kacheln = html.split(/class="cd-tile-v-box\b/).slice(1);
  for (const k of kacheln) {
    const ziel = /window\.location\.href='([^']{1,400})'/.exec(k)?.[1]?.replace(/&amp;/g, '&');
    if (!ziel) continue;
    // Nur ein Pfad derselben Seite samt Abfrage — keine fremde Herkunft, kein anderer Pfad.
    const praefix = `${SPIELBETRIEB_PFAD}/${seite}?`;
    if (!ziel.startsWith(praefix) || /[\s"<>#]/.test(ziel)) continue;
    const gruppe = /^GD(\d{1,12})$/.exec(new URLSearchParams(ziel.slice(praefix.length)).get('c') ?? '')?.[1];
    const name = /cd-tile-v-main-heading"[^>]*>([\s\S]*?)<\/div>/.exec(k)?.[1];
    if (!gruppe || !name || !text(name)) continue;
    const src = /<img[^>]*?src="([^"]+)"[^>]*alt="Gruppenfoto"/.exec(k)?.[1];
    const bild = src ? bildAus(src) : null;
    out.push({ groupId: gruppe, name: text(name), detailPfad: ziel, imageId: bild?.imageId ?? null, signature: bild?.signature ?? null });
  }
  return out;
}

/**
 * Die Detailseite einer Gruppe: die Kontakte als Kacheln, die Rolle als
 * Untertitel. Eine Position gibt es hier nicht.
 */
export function parseGruppendetail(html: string): ClubdeskPerson[] {
  const out: ClubdeskPerson[] = [];
  const start = html.search(/class="cd-group-contact-list\b/);
  if (start < 0) return out;
  for (const k of html.slice(start).split(/class="cd-tile-v-box\b/).slice(1)) {
    const contact = /contact-(\d{1,12})"/.exec(k)?.[1];
    const name = /cd-tile-v-main-heading"[^>]*>([\s\S]*?)<\/div>/.exec(k)?.[1];
    if (!contact || !name || !text(name)) continue;
    const rolle = /cd-tile-v-main-subheading"[^>]*>([\s\S]*?)<\/div>/.exec(k)?.[1];
    const src = /<img[^>]*?src="([^"]+)"[^>]*alt="Kontaktfoto"/.exec(k)?.[1];
    const bild = src ? bildAus(src) : null;
    out.push({ contactId: contact, name: text(name), section: rolle ? text(rolle) : '', position: null, imageId: bild?.imageId ?? null, signature: bild?.signature ?? null });
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

/** Macht den nächsten Abruf fällig — nach einer geänderten Foto-Freigabe auf der Einstellungsseite. */
export function clubdeskFaelligMachen(): void {
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
 * (Jugend nur mit Freigabe) und die Porträts (Jugend nur
 * mit freigegebenen Spielerbildern). Geladen wird
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
    // Jede Seite höchstens einmal je Lauf — die Übersicht nur, wenn eine Teamseite eingetragen ist.
    const seiten = new Map<string, Promise<string>>();
    const seite = (pfad: string) => {
      if (!seiten.has(pfad)) seiten.set(pfad, safeFetchHtml(`${basis}${pfad}`, { allowHost: nurHost }));
      return seiten.get(pfad)!;
    };
    for (const [teamId, slug] of zuordnung) {
      const [seitenName, gruppenId] = slug.split(':');
      let gruppe: { caption: string; imageId: string; signature: string } | null;
      let personenPfad: string | null;
      let jugend: boolean;
      let personenLesen: (html: string) => ClubdeskPerson[];
      if (gruppenId) {
        // Eine Gruppe auf einer Seite mit Gruppenkacheln (Kinderhandball): immer Jugend.
        const kachel = parseGruppenkacheln(await seite(`${SPIELBETRIEB_PFAD}/${seitenName}`), seitenName).find(k => k.groupId === gruppenId) ?? null;
        if (!kachel) serviceLog.warn(`[clubdesk] Gruppe ${gruppenId} auf /spielbetrieb/${seitenName} nicht gefunden (Team ${teamId})`);
        gruppe = kachel?.imageId && kachel.signature ? { caption: kachel.name, imageId: kachel.imageId, signature: kachel.signature } : null;
        personenPfad = kachel?.detailPfad ?? null;
        jugend = true;
        personenLesen = parseGruppendetail;
      } else {
        const g = parseUebersicht(await seite(TEAMS_PFAD)).find(x => x.slug === slug) ?? null;
        gruppe = g;
        personenPfad = `${TEAMS_PFAD}/${slug}`;
        jugend = istJugend(teamLabels.get(teamId), g?.caption);
        personenLesen = parseTeamseite;
      }
      const frei = sitePhotos().get(teamId);
      if (jugend && !frei?.gruppe && !frei?.spieler) {
        // Jugendbilder nur mit ausdrücklicher Freigabe — sonst auch nicht vorhalten.
        db.delete(clubdesk_photo).where(eq(clubdesk_photo.team_id, teamId)).run();
        continue;
      }
      if (jugend && !frei?.gruppe) {
        db.delete(clubdesk_photo).where(eq(clubdesk_photo.id, `${teamId}:gruppe`)).run();
      } else if (gruppe) {
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
      if (jugend && !frei?.spieler) {
        // Jugend-Porträts nur mit ausdrücklicher Freigabe der Spielerbilder — sonst auch nicht vorhalten.
        db.delete(clubdesk_photo).where(and(eq(clubdesk_photo.team_id, teamId), eq(clubdesk_photo.kind, 'person'))).run();
        continue;
      }
      if (!personenPfad) continue;
      try {
        const personen = personenLesen(await safeFetchHtml(`${basis}${personenPfad}`, { allowHost: nurHost }));
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
        serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, `[clubdesk] Seite ${slug} nicht abrufbar`);
      }
    }
    // Mannschaften, die aus CLUBDESK_TEAMS verschwunden sind, nicht weiter vorhalten.
    db.delete(clubdesk_photo).where(notInArray(clubdesk_photo.team_id, [...zuordnung.keys()])).run();
    return { status: 'ok', geladen };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    serviceLog.warn({ err: detail }, '[clubdesk] Übersicht oder Gruppenseite nicht abrufbar');
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
