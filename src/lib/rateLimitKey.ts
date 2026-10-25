/**
 * Der Schlüssel, unter dem das Rate-Limit eine Anfrage zählt (SEC-3-005).
 *
 * IPv4 zählt je Adresse. IPv6 zählt je /64: Wer ein Präfix hat (jeder VPS,
 * viele Anschlüsse), kann darin beliebig viele Adressen wählen — je /128
 * gezählt, wären Anmeldung, Push und Bilder praktisch ungedrosselt.
 * IPv4 in IPv6 (`::ffff:203.0.113.7`) zählt als die IPv4-Adresse.
 */
import net from 'node:net';

export function rateLimitSchluessel(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (net.isIPv6(ip)) return `${ersteVierGruppen(ip)}::/64`;
  return ip;
}

/** Die ersten vier 16-Bit-Gruppen einer IPv6-Adresse, ausgeschrieben und klein. */
function ersteVierGruppen(ip: string): string {
  const ohneZone = ip.split('%')[0]!.toLowerCase();
  const [links, rechts = ''] = ohneZone.split('::');
  const l = links ? links.split(':') : [];
  const r = ohneZone.includes('::') && rechts ? rechts.split(':') : [];
  const fehlend = ohneZone.includes('::') ? 8 - l.length - r.length : 0;
  const gruppen = [...l, ...Array(Math.max(0, fehlend)).fill('0'), ...r];
  return gruppen.slice(0, 4).map(g => (parseInt(g || '0', 16) || 0).toString(16)).join(':');
}
