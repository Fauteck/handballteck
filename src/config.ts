/**
 * Die Konfiguration von Handballteck — alles aus der Umgebung, bei jedem
 * Aufruf frisch gelesen.
 *
 * In Todoteck stand dasselbe in der Dienste-Zeile „Handball (handball.net)"
 * und war dort ohne Neustart änderbar. Ein eigener Container hat keine
 * Einstellungsseite; seine Konfiguration ist die `.env` neben der Compose
 * (siehe `.env.example`). Gelesen wird je Aufruf statt einmal beim Start,
 * damit Tests die Umgebung umschalten können und der Code an keiner Stelle
 * einen veralteten Wert festhält.
 */

import type { HandballPalette } from './lib/handballTableImage';

const env = (name: string): string | undefined => {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

function schalter(name: string, standard: boolean): boolean {
  const v = env(name);
  if (v === undefined) return standard;
  if (/^(true|1|ja|an|on|yes)$/i.test(v)) return true;
  if (/^(false|0|nein|aus|off|no)$/i.test(v)) return false;
  return standard;
}

export interface TeamEntry {
  id: string;
  /** Ein Name aus der Konfiguration (`96254=B-Jugend`); null heißt: die Altersklasse der Quelle. */
  label: string | null;
}

/**
 * Die Mannschaften: Ziffernfolgen, durch Komma, Semikolon, Leerzeichen oder
 * Zeilenumbruch getrennt, je optional mit `=Name`. Die ID steht in der
 * Adresse der Mannschaftsseite auf handball.net (`/team/96254`).
 */
export function parseTeamEntries(roh: unknown): TeamEntry[] {
  if (Array.isArray(roh)) return parseTeamEntries(roh.map(String).join(','));
  const text = typeof roh === 'string' ? roh : '';
  const out: TeamEntry[] = [];
  const nimm = (id: string, label: string | null) => {
    if (/^\d{1,12}$/.test(id) && !out.some(e => e.id === id)) out.push({ id, label: label || null });
  };
  for (const teil of text.split(/[,;\n]+/)) {
    const t = teil.trim();
    if (!t) continue;
    if (t.includes('=')) {
      // `96254=B-Jugend` — der Name darf Leerzeichen enthalten.
      const [idRoh, ...rest] = t.split('=');
      nimm(idRoh.trim(), rest.join('=').trim());
    } else {
      // Nur IDs: auch durch Leerzeichen getrennt („96254 96300").
      for (const id of t.split(/\s+/)) nimm(id.trim(), null);
    }
  }
  return out;
}

export function parseTeamIds(roh: unknown): string[] {
  return parseTeamEntries(roh).map(e => e.id);
}

export function teamEntries(): TeamEntry[] {
  return parseTeamEntries(env('TEAM_IDS'));
}

export function teamIds(): string[] {
  return teamEntries().map(e => e.id);
}

/** Der konfigurierte Name einer Mannschaft — null, wenn keiner gesetzt ist. */
export function teamLabelAusConfig(teamId: string): string | null {
  return teamEntries().find(e => e.id === teamId)?.label ?? null;
}

function farbe(name: string): string | undefined {
  const v = env(name);
  return v && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined;
}

/** Die Vereinsfarben — was fehlt oder nicht passt, bleibt leer, `themeFor` setzt dann die Wölfe-Farben ein. */
export function palette(): Partial<HandballPalette> {
  return { primary: farbe('PRIMARY_COLOR'), secondary: farbe('SECONDARY_COLOR'), accent: farbe('ACCENT_COLOR') };
}

export function publicUrl(): string {
  return (env('PUBLIC_URL') || `http://localhost:${env('PORT') || 3000}`).replace(/\/+$/, '');
}

export function port(): number {
  const n = Number.parseInt(env('PORT') || '3000', 10);
  return Number.isFinite(n) && n > 0 ? n : 3000;
}

/**
 * Welchen Reverse-Proxys der Dienst `X-Forwarded-For` glaubt
 * (`TRUST_PROXY`): IP-Adressen oder CIDR-Bereiche, durch Komma getrennt.
 * Leer heißt **keinem** — dann ist `request.ip` der letzte Proxy, und alle
 * Aufrufer teilen sich einen Rate-Limit-Eimer. Das ist lästig, aber kein Loch.
 *
 * Bewusst keine Zahl von Sprüngen, wie Todoteck sie mit `TRUST_PROXY_HOPS`
 * hat: Fastify nimmt eine Zahl seit Version 5.12 nicht mehr an und vertraut
 * dann still keinem Proxy (lib/request.js, `getTrustProxyFn`), weil eine
 * Sprungzahl den unmittelbaren Absender nicht prüfen kann — ein direkter
 * Aufrufer könnte sich genug Einträge ausdenken. Und bewusst nie `true`: Das
 * glaubte jedem Aufrufer jede Adresse, und jedes Rate-Limit wäre umgehbar.
 */
export function trustProxy(): string[] | false {
  const text = env('TRUST_PROXY') ?? '';
  const liste = text.split(/[\s,;]+/).map(t => t.trim()).filter(t => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(t));
  return liste.length > 0 ? liste : false;
}

export function dataDir(): string {
  return env('DATA_DIR') || './data';
}

export function databasePath(): string {
  return env('DATABASE_PATH') || `${dataDir().replace(/\/+$/, '')}/handballteck.db`;
}

/** Wie oft der Abruf läuft — Standard 15 Minuten, unter 5 Minuten wird auf 5 gesetzt. */
export function syncIntervalMs(): number {
  const n = Number.parseInt(env('SYNC_INTERVAL_MS') || '', 10);
  const standard = 15 * 60 * 1000;
  if (!Number.isFinite(n) || n <= 0) return standard;
  return Math.max(n, 5 * 60 * 1000);
}

// --- Telegram ---------------------------------------------------------------

export function botToken(): string | null {
  return env('TELEGRAM_BOT_TOKEN') ?? null;
}

export function inviteCode(): string | null {
  return env('TELEGRAM_INVITE_CODE') ?? null;
}

/** Die Admin-Chats — leer, wenn keiner eingetragen ist. */
export function adminChatIds(): Set<string> {
  const text = env('TELEGRAM_ADMIN_CHAT_IDS') ?? '';
  return new Set(text.split(/[\s,;]+/).map(t => t.trim()).filter(t => /^-?\d{1,20}$/.test(t)));
}

/** Beschreibung und Kurzbeschreibung des Bots aus dem Stand pflegen — Standard an. */
export function botAutoDescription(): boolean {
  return schalter('BOT_AUTO_DESCRIPTION', true);
}

// --- Microsite ----------------------------------------------------------------

export function siteEnabled(): boolean {
  return schalter('SITE_ENABLED', true);
}

export function sitePlayers(): boolean {
  return schalter('SITE_PLAYERS', false);
}

/**
 * Die Wurzel, unter der ein Proxy die Seiten von außen ausliefert — ohne
 * Schrägstrich am Ende; null, wenn keine gesetzt oder unbrauchbar ist (dann
 * gilt `PUBLIC_URL`). Nur eine vollständige https-Adresse ohne Parameter.
 */
export function siteUrl(): string | null {
  const v = env('SITE_URL');
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.search || u.hash) return null;
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function siteOperator(): string | null {
  return env('SITE_OPERATOR') ?? null;
}

export function siteFeedbackMail(): string | null {
  return env('SITE_FEEDBACK_MAIL') ?? null;
}

// --- API für Todoteck -------------------------------------------------------

export function apiToken(): string | null {
  return env('API_TOKEN') ?? null;
}

/**
 * Pfad zu einer Todoteck-Datenbank (Kopie oder Backup), aus der beim Start
 * einmalig übernommen wird — siehe `src/import/todoteck.ts`. Leer: kein Import.
 */
export function importTodoteckDb(): string | null {
  return env('IMPORT_TODOTECK_DB') ?? null;
}

export function version(): { sha: string; builtAt: string } {
  return { sha: env('GIT_SHA') ?? 'dev', builtAt: env('BUILT_AT') ?? 'unbekannt' };
}
