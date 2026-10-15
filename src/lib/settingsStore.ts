/**
 * Speicher der Einstellungsseite: Werte in der Tabelle `settings` unter
 * `cfg.<NAME>`, Protokoll in `settings_audit`. Beim Start und nach jedem
 * Speichern werden die Werte an `config.ts` gereicht (`setConfigOverrides`);
 * von da an gehen sie der Umgebung vor.
 */
import { desc, eq, count } from 'drizzle-orm';
import { db, sqlite } from '../db';
import { settings_audit } from '../db/schema';
import { setConfigOverrides, configOverride } from '../config';
import { EINSTELLUNGEN, findeEinstellung } from './settingsRegistry';
import { serviceLog } from './serviceLogger';

const PRAEFIX = 'cfg.';
const MASKE = '●●●';

/** Liest alle gespeicherten Werte und reicht sie an die Konfiguration. */
export function ladeEinstellungen(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const rows = sqlite.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all(`${PRAEFIX}%`) as { key: string; value: string }[];
    for (const r of rows) {
      const name = r.key.slice(PRAEFIX.length);
      if (findeEinstellung(name)) map.set(name, r.value);
    }
  } catch (err) {
    serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[settings] Werte nicht gelesen — es gilt die Umgebung');
  }
  setConfigOverrides(map);
  return map;
}

export type Quelle = 'seite' | 'umgebung' | 'standard';

export function quelleVon(key: string): Quelle {
  if (configOverride(key) !== undefined) return 'seite';
  const v = process.env[key];
  return typeof v === 'string' && v.trim() !== '' ? 'umgebung' : 'standard';
}

/** Der wirksame Wert als Text: Seite, sonst Umgebung, sonst leer. */
export function wirksamerText(key: string): string {
  const o = configOverride(key);
  if (o !== undefined) return o;
  return process.env[key]?.trim() ?? '';
}

type Aenderungs = (keys: string[]) => void | Promise<void>;
const lauscher: Aenderungs[] = [];

/** Meldet sich für „Einstellungen geändert“ an (der Takt wird dort angestoßen). */
export function beiAenderung(fn: Aenderungs): void {
  lauscher.push(fn);
}

function protokolliere(actor: string, key: string, action: 'set' | 'reset', alt: string | null, neu: string | null): void {
  const geheim = findeEinstellung(key)?.art === 'geheim';
  db.insert(settings_audit).values({
    at: new Date().toISOString(), actor, key, action,
    old_value: alt === null ? null : geheim ? MASKE : alt,
    new_value: neu === null ? null : geheim ? MASKE : neu,
  }).run();
}

export interface Aenderung {
  key: string;
  /** `null`: auf die Umgebung zurücksetzen. */
  wert: string | null;
}

/**
 * Schreibt mehrere Änderungen in einer Transaktion. Die Werte sind schon
 * geprüft (`Einstellung.pruefe`); unbekannte Schlüssel lehnt die Funktion ab.
 * Gibt die tatsächlich geänderten Schlüssel zurück.
 */
export function speichere(aenderungen: Aenderung[], actor: string): string[] {
  const geaendert: string[] = [];
  const jetzt = new Date().toISOString();
  const lauf = sqlite.transaction(() => {
    for (const a of aenderungen) {
      if (!findeEinstellung(a.key)) throw new Error(`Unbekannte Einstellung ${a.key}`);
      const alt = configOverride(a.key) ?? null;
      if (a.wert === null) {
        if (alt === null) continue;
        sqlite.prepare('DELETE FROM settings WHERE key = ?').run(PRAEFIX + a.key);
        protokolliere(actor, a.key, 'reset', alt, null);
        geaendert.push(a.key);
      } else {
        if (alt === a.wert) continue;
        sqlite.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
          .run(PRAEFIX + a.key, a.wert, jetzt);
        protokolliere(actor, a.key, 'set', alt, a.wert);
        geaendert.push(a.key);
      }
    }
  });
  lauf();
  if (geaendert.length > 0) {
    ladeEinstellungen();
    for (const fn of lauscher) {
      try { void Promise.resolve(fn(geaendert)).catch(err => serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[settings] Folgeaktion gescheitert')); }
      catch (err) { serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[settings] Folgeaktion gescheitert'); }
    }
  }
  return geaendert;
}

export interface ProtokollZeile { at: string; actor: string; key: string; action: string; old_value: string | null; new_value: string | null }

export function protokoll(limit = 50, offset = 0, key?: string): ProtokollZeile[] {
  const basis = db.select().from(settings_audit);
  const gefiltert = key ? basis.where(eq(settings_audit.key, key)) : basis;
  return gefiltert.orderBy(desc(settings_audit.id)).limit(limit).offset(offset).all()
    .map(({ at, actor, key: k, action, old_value, new_value }) => ({ at, actor, key: k, action, old_value, new_value }));
}

/** Zahl der Protokollzeilen, optional nur einer Einstellung — für das Blättern auf der Seite. */
export function protokollAnzahl(key?: string): number {
  const basis = db.select({ n: count() }).from(settings_audit);
  const zeile = (key ? basis.where(eq(settings_audit.key, key)) : basis).get();
  return zeile?.n ?? 0;
}

/** Die wirksamen Werte als `.env`-Block (ohne Geheimnisse) — zum Übernehmen in docker-configs. */
export function alsEnvBlock(): string {
  const zeilen = ['# Handballteck — wirksame Einstellungen der Seite /settings (ohne Geheimnisse)'];
  for (const e of EINSTELLUNGEN) {
    if (e.art === 'geheim') continue;
    const v = wirksamerText(e.key);
    if (v !== '') zeilen.push(`${e.key}=${v}`);
  }
  return zeilen.join('\n') + '\n';
}

let syncAktion: (() => Promise<void>) | null = null;

/** Der Takt (in `index.ts`) meldet hier an, wie ein Lauf sofort angestoßen wird. */
export function setzeSyncAktion(fn: () => Promise<void>): void {
  syncAktion = fn;
}

/** Stößt einen Lauf an; false, wenn kein Takt angemeldet ist (z. B. in Tests). */
export function syncJetzt(): boolean {
  if (!syncAktion) return false;
  void syncAktion().catch(err => serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[settings] Lauf gescheitert'));
  return true;
}
