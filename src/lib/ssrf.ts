/**
 * SSRF-Schutz fuer ausgehende HTTP-Requests aus dem Server (Widget-Proxies
 * wie RSS, Wetter-Proxy, etc.). Sperrt private/Loopback-Adressen und
 * Credentials-im-URL, damit ein User nicht ueber das Backend interne
 * Systeme abfragen kann.
 *
 * Portiert aus Dashteck (lib/ssrf.js). Beachte: das ist eine
 * hostname-basierte Pruefung, kein DNS-Resolving.
 *
 * ## Wann das hier reicht — und wann nicht (SSRF-PRIO-004, 06.09.2026)
 *
 * **Reicht nicht**, sobald der Aufrufer das Ziel bestimmt. Eine oeffentlich
 * aussehende Domain mit einem A-Record auf `192.168.x.x` besteht diese
 * Pruefung, weil sie den Namen ansieht und nicht die Adresse dahinter. Fuer
 * solche Ziele fuehrt der Weg ueber `lib/safeFetch.ts`: DNS aufloesen, jede
 * Adresse pruefen, Verbindung an die gepruefte Adresse pinnen, jeden
 * Weiterleitungs-Sprung erneut pruefen.
 *
 * **Reicht**, wenn die URL aus der Konfiguration kommt — Home Assistant,
 * AdGuard, Spoolman. Dort hat der Betreiber das Ziel eingetragen, nicht der
 * Angreifer; die Namenspruefung haelt nur noch Tippfehler und offensichtlich
 * Internes ab. Die volle Aufloesung waere dort sogar schaedlich: Zeigt der
 * eingetragene oeffentliche Name im eigenen Haus per Split-DNS auf eine
 * private Adresse, wuerde sie die Integration abschalten.
 *
 * Ausfuehrlich samt Abgrenzung: `docs/ssrf-abwehr.md`.
 */
const PRIVATE_IP_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|0\.0\.0\.0|::1$|::$|fc|fd)/i;
const PRIVATE_HOSTNAMES = new Set(['localhost', '::1', '0.0.0.0', '']);

/**
 * Erkennt nicht-kanonische IP-Kodierungen, die zwar auf eine IP aufloesen
 * (z.B. `getaddrinfo("2130706433")` -> 127.0.0.1), aber an der dotted-decimal
 * Pruefung in PRIVATE_IP_RE vorbeirutschen wuerden: Integer (`2130706433`),
 * Hex (`0x7f000001`, `0x7f.0.0.1`) und Oktal (`0177.0.0.1`). Echte Hostnames
 * enthalten Buchstaben/TLD und werden hier nicht erfasst — daher keine
 * False-Positives fuer regulaere Domains.
 */
function isNonCanonicalNumericHost(h: string): boolean {
  if (/^0x[\da-f]+$/i.test(h)) return true; // reine Hex-Zahl
  if (/^\d+$/.test(h)) return true; // reine Integer-Zahl
  const parts = h.split('.');
  if (parts.length < 2) return false;
  // Rein numerische dotted-Form: blocken, sobald ein Oktett hex- oder
  // oktal-kodiert ist (kanonisches dotted-decimal deckt PRIVATE_IP_RE ab).
  const allNumeric = parts.every((p) => /^(0x[\da-f]+|\d+)$/i.test(p));
  if (!allNumeric) return false;
  return parts.some((p) => /^0x/i.test(p) || /^0\d+$/.test(p));
}

export function isPrivateHost(hostname: string | null | undefined): boolean {
  if (!hostname) return true;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return PRIVATE_HOSTNAMES.has(h) || PRIVATE_IP_RE.test(h) || isNonCanonicalNumericHost(h);
}

export function isSafeExternalUrl(raw: string, opts: { requireHttps?: boolean } = {}): boolean {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (opts.requireHttps && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (isPrivateHost(parsed.hostname)) return false;
  return true;
}

/**
 * SEC-1-001: Die Push-Dienste der Browser, an die eine Web-Push-Anmeldung
 * zeigen darf. Den Endpoint schickt der Browser, also jeder, der die
 * Microsite aufruft — ohne diese Liste wäre `POST /<Team>/push` ein
 * Werkzeug, mit dem der Server beliebige HTTPS-Ziele anspricht (auch im
 * eigenen Netz) und bei jeder Meldung an alle eingetragenen Ziele sendet.
 *
 * Chrome, Opera, Samsung Internet, Brave → FCM; Firefox → Mozilla Autopush;
 * Edge → WNS; Safari (macOS, iOS ab 16.4) → Apple. Ein Browser mit einem
 * anderen Dienst kommt hier mit 400 an und taucht dann im Log auf.
 */
const PUSH_HOSTS_EXAKT = new Set(['fcm.googleapis.com']);
const PUSH_HOSTS_ENDUNG = ['.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com'];

export function isPushServiceUrl(raw: string): boolean {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return false; }
  if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return PUSH_HOSTS_EXAKT.has(host) || PUSH_HOSTS_ENDUNG.some(e => host.endsWith(e));
}
