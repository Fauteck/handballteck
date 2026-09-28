/**
 * safeFetch — SSRF-gehaerteter Outbound-Fetch fuer BELIEBIGE, nutzergelieferte
 * URLs (Web-Capture / OG-Metadaten / lesbarer Snapshot).
 *
 * Strenger als `isSafeExternalUrl` allein (das ist rein hostname-basiert, siehe
 * `lib/ssrf.ts`). Diese Schicht ergaenzt die dort im Kommentar geforderte
 * DNS-Aufloesung + IP-Pruefung vor dem Connect:
 *
 *   1. URL-Check via `isSafeExternalUrl` (Schema, Credentials-im-URL,
 *      nicht-kanonische IP-Kodierungen).
 *   2. DNS-Aufloesung -> JEDE aufgeloeste IP gegen `isPrivateHost` pruefen.
 *      Faengt DNS-basierte Umgehung ab (oeffentlich aussehende Domain, die auf
 *      127.0.0.1 / 10.x / 169.254.169.254 zeigt).
 *   3. Verbindung an die validierte IP pinnen (lookup-Override) -> kein
 *      DNS-Rebinding zwischen Pruefung und Connect (TOCTOU geschlossen).
 *   4. Redirects manuell verfolgen und JEDEN Hop erneut voll pruefen (max. 5).
 *   5. Timeout ueber die gesamte Redirect-Kette + harte Body-Groessenbegrenzung.
 *   6. Optional `allowHost`: eine Host-Allowlist des Aufrufers, ebenfalls je
 *      Sprung geprueft (Untappd-Proxy).
 *
 * Der generische Pfad ist nur aktiv, wenn der Nutzer ihn aktiviert hat
 * (Preference `web_fetch_public_enabled`, siehe `webMetadata.isPublicFetchAllowed`).
 * Der bestehende 3D-Plattform-Pfad (og-scraper, curl-impersonate, Whitelist)
 * bleibt davon unberuehrt.
 */
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookupCb, type LookupAddress } from 'node:dns';
import { promisify } from 'node:util';
import { isSafeExternalUrl, isPrivateHost } from './ssrf';

const dnsLookupAll = promisify(
  (hostname: string, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) =>
    dnsLookupCb(hostname, { all: true }, cb),
);

/** Injizierbarer Resolver (Tests koennen DNS ohne Netz simulieren). */
export type AddressResolver = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolver: AddressResolver = (hostname) => dnsLookupAll(hostname);

export interface SafeFetchOptions {
  /** Gesamt-Timeout ueber alle Redirects hinweg (ms). Default 8000. */
  timeoutMs?: number;
  /** Harte Obergrenze fuer den Body (Bytes). Default 2 MB. */
  maxBytes?: number;
  /**
   * Bei Ueberschreiten von `maxBytes` den Body abschneiden statt mit Fehler
   * abzubrechen. Fuer HTML sinnvoll (Parser kommt mit angeschnittenem Markup
   * klar, der Seitenanfang traegt den Inhalt); fuer Bilder u. ae. nicht.
   */
  truncateOnLimit?: boolean;
  /** Max. Anzahl gefolgter Redirects. Default 5. */
  maxRedirects?: number;
  /**
   * Zusaetzliche Zusicherung ueber den Ziel-Host, **je Sprung** geprueft.
   *
   * Fuer Aufrufer, die nicht nur „irgendwas Oeffentliches" holen, sondern
   * einen bestimmten Dienst: Der Untappd-Proxy etwa laesst nur `untappd.com`
   * zu. Ohne diese Pruefung an jedem Hop haette eine Weiterleitung des
   * erlaubten Hosts den Proxy zu einem beliebigen anderen oeffentlichen Ziel
   * gemacht — die Allowlist haette dann nur den ersten Sprung gedeckt.
   */
  allowHost?: (url: URL) => boolean;
  accept?: string;
  acceptLanguage?: string;
  /** Nur fuer Tests: Resolver-Override. */
  resolver?: AddressResolver;
}

export interface SafeFetchResult {
  status: number;
  buffer: Buffer;
  contentType: string | null;
  /** URL nach allen Redirects. */
  finalUrl: string;
}

/** Ausgehender Fetch wurde aus SSRF-Gruenden blockiert. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * Der Body hat `maxBytes` überschritten und wurde abgebrochen (nur ohne
 * `truncateOnLimit`). Eigene Klasse statt generischem `Error`, damit Aufrufer
 * „zu groß" von „nicht erreichbar" unterscheiden können, ohne auf den
 * Meldungstext zu matchen — der Unterschied zählt, wenn die Größe eine
 * Konfigurationsfrage ist (siehe `haRundblickSync.ensureEditionPdfAttachment`).
 */
export class ResponseTooLargeError extends Error {
  readonly limitBytes: number;
  constructor(limitBytes: number) {
    super(`Antwort zu groß (> ${limitBytes} Bytes)`);
    this.name = 'ResponseTooLargeError';
    this.limitBytes = limitBytes;
  }
}

interface ResolvedTarget {
  address: string;
  family: number;
}

/**
 * Validiert eine URL vollstaendig (Hostname-Regeln + DNS-Aufloesung) und liefert
 * die gepinnte Ziel-IP zurueck. Wirft `SsrfBlockedError`, sobald die URL selbst
 * oder EINE der aufgeloesten IPs privat/reserviert ist. Separat exportiert, damit
 * die SSRF-Logik ohne Netzwerk unit-getestet werden kann (Resolver injizierbar).
 */
export async function assertUrlFetchable(rawUrl: string, resolver: AddressResolver = defaultResolver): Promise<ResolvedTarget> {
  if (!isSafeExternalUrl(rawUrl)) {
    throw new SsrfBlockedError(`URL nicht erlaubt: ${rawUrl}`);
  }
  const hostname = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  let addresses: LookupAddress[];
  try {
    addresses = await resolver(hostname);
  } catch (err) {
    throw new SsrfBlockedError(`DNS-Aufloesung fehlgeschlagen: ${hostname}`);
  }
  if (!addresses.length) {
    throw new SsrfBlockedError(`Keine Adresse fuer ${hostname}`);
  }
  for (const a of addresses) {
    if (isPrivateHost(a.address)) {
      throw new SsrfBlockedError(`Aufgeloeste IP privat/reserviert: ${hostname} -> ${a.address}`);
    }
  }
  return { address: addresses[0].address, family: addresses[0].family };
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  buffer: Buffer;
}

/**
 * Ein einzelner Request an die bereits validierte, gepinnte IP. Folgt KEINEN
 * Redirects selbst (das steuert `safeFetch`), damit jeder Hop erneut geprueft
 * werden kann. Der Connect geht an `target.address`, Host-Header und TLS-SNI
 * bleiben der Hostname aus der URL.
 */
export function requestOnce(
  url: URL,
  target: ResolvedTarget,
  opts: { deadline: number; maxBytes: number; truncateOnLimit?: boolean; accept?: string; acceptLanguage?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const timeoutMs = Math.max(1, opts.deadline - Date.now());

    const headers: Record<string, string> = {
      'User-Agent': 'Handballteck/1.0',
      Accept: opts.accept ?? '*/*',
      // Virtuellen Host erhalten, obwohl wir direkt zur IP verbinden.
      Host: url.host,
    };
    if (opts.acceptLanguage) headers['Accept-Language'] = opts.acceptLanguage;

    const req = transport.request(
      {
        protocol: url.protocol,
        // IP-Pinning ohne custom `lookup`: direkt zur validierten IP verbinden.
        // `Host`-Header und (bei TLS) `servername` bleiben der echte Hostname,
        // damit Virtual-Hosting und Zertifikatspruefung korrekt sind.
        host: target.address,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers,
        timeout: timeoutMs,
        ...(isHttps ? { servername: url.hostname } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          fn();
        };
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          total += chunk.length;
          if (total > opts.maxBytes) {
            if (opts.truncateOnLimit) {
              // Rest des Chunks bis zur Grenze mitnehmen, dann sauber kappen.
              const keep = chunk.length - (total - opts.maxBytes);
              if (keep > 0) chunks.push(chunk.subarray(0, keep));
              settle(() => resolve({ status: res.statusCode ?? 0, headers: res.headers, buffer: Buffer.concat(chunks) }));
              req.destroy();
              return;
            }
            settle(() => reject(new ResponseTooLargeError(opts.maxBytes)));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          settle(() => resolve({ status: res.statusCode ?? 0, headers: res.headers, buffer: Buffer.concat(chunks) }));
        });
        res.on('error', (err) => settle(() => reject(err)));
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('Timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * SSRF-sicherer GET fuer beliebige oeffentliche URLs. Validiert Start-URL und
 * jeden Redirect-Hop (Hostname + aufgeloeste IP), pinnt die Verbindung an die
 * validierte IP und begrenzt Body und Gesamtlaufzeit.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 5;
  const resolver = options.resolver ?? defaultResolver;
  const deadline = Date.now() + timeoutMs;

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (Date.now() >= deadline) throw new Error('Timeout');
    const target = await assertUrlFetchable(currentUrl, resolver);
    const url = new URL(currentUrl);
    if (options.allowHost && !options.allowHost(url)) {
      throw new SsrfBlockedError(`Host nicht erlaubt: ${url.hostname}`);
    }
    const res = await requestOnce(url, target, {
      deadline,
      maxBytes,
      truncateOnLimit: options.truncateOnLimit,
      accept: options.accept,
      acceptLanguage: options.acceptLanguage,
    });

    // Redirect? Location gegen aktuelle URL aufloesen und Hop erneut pruefen.
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      const next = new URL(res.headers.location, url).toString();
      currentUrl = next;
      continue;
    }

    const contentType = (res.headers['content-type'] as string | undefined)?.split(';')[0].trim().toLowerCase() ?? null;
    return { status: res.status, buffer: res.buffer, contentType, finalUrl: url.toString() };
  }
  throw new Error(`Zu viele Redirects (> ${maxRedirects})`);
}

/**
 * Convenience: laedt eine oeffentliche Seite und liefert das HTML als String.
 * Wirft bei Nicht-2xx.
 */
export async function safeFetchHtml(rawUrl: string, options: SafeFetchOptions = {}): Promise<string> {
  const res = await safeFetch(rawUrl, {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    acceptLanguage: options.acceptLanguage ?? 'de-DE,de;q=0.9,en;q=0.8',
    // Moderne Shop-/Portal-Seiten liegen unkomprimiert oft ueber 2 MB. Fuer
    // HTML gilt: lieber den (inhaltstragenden) Seitenanfang behalten als den
    // ganzen Snapshot mit „Antwort zu gross" scheitern zu lassen.
    maxBytes: options.maxBytes ?? 4 * 1024 * 1024,
    truncateOnLimit: options.truncateOnLimit ?? true,
    ...options,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} beim Laden von ${rawUrl}`);
  }
  return res.buffer.toString('utf8');
}

const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export interface SafeFetchedImage {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Convenience: laedt ein oeffentliches Bild (fuer OG-Vorschaubilder). Begrenzt
 * auf 10 MB und akzeptiert nur die gaengigen Rasterformate.
 */
export async function safeFetchImage(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchedImage> {
  const res = await safeFetch(rawUrl, {
    accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    maxBytes: options.maxBytes ?? 10 * 1024 * 1024,
    timeoutMs: options.timeoutMs ?? 10000,
    ...options,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} beim Laden des Bildes ${rawUrl}`);
  }
  const raw = res.contentType ?? '';
  const mimeType = ALLOWED_IMAGE_MIMES.has(raw) ? raw : mimeFromExtension(rawUrl);
  if (!mimeType) {
    throw new Error(`Bild-MIME nicht unterstuetzt: ${raw || 'unbekannt'}`);
  }
  return { buffer: res.buffer, mimeType };
}

function mimeFromExtension(url: string): string | null {
  const ext = url.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    default: return null;
  }
}
