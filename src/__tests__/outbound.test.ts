import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { PUSH_HOSTS_EXAKT, PUSH_HOSTS_ENDUNG } from '../lib/ssrf';
import { HANDBALL_LOGO_HOSTS } from '../lib/handballNetClient';

/**
 * Ausgehende Verbindungen: Jeder fremde Host, den der Code kennt, steht in der
 * Tabelle „Outbound connections“ der README — und jede Zeile dort hat ihren
 * Host noch im Code. Ohne diesen Test wüsste nach der nächsten Integration
 * niemand mehr ohne grep, wohin der Server spricht. Muster aus Todoteck
 * (`scripts/outbound-guard.mjs`), hier als Test, weil die Guards dieses Repos
 * Tests sind und so ohne eigenen Schritt im `quality`-Job laufen.
 */

const README = 'README.md';
const ARTEN = new Set(['Connection', 'Link', 'Identifier', 'Default', 'Browser']);

function dateien(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__') dateien(p, out);
    } else if (/\.(ts|js|mjs)$/.test(name) && !/\.(test|e2e)\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Kommentare grob entfernen: Blockkommentare ganz, Zeilenkommentare ab `//`,
 * sofern davor kein `:` steht (das wäre das `//` einer URL). In Kommentaren
 * stehen Beispiele und Quellenangaben, keine Ziele.
 */
function ohneKommentare(quelle: string): string {
  return quelle
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(zeile => zeile.replace(/(^|[^:\\])\/\/.*$/, '$1'))
    .join('\n');
}

/** Hosts aus Zeichenketten, die mit Anführungszeichen oder Backtick und `http(s)://` beginnen. */
function hostsIn(quelle: string): Set<string> {
  const hosts = new Set<string>();
  for (const m of ohneKommentare(quelle).matchAll(/['"`]https?:\/\/([a-zA-Z0-9_.-]+)/g)) {
    hosts.add(m[1].toLowerCase());
  }
  return hosts;
}

function hostsImCode(): Map<string, Set<string>> {
  const gefunden = new Map<string, Set<string>>();
  const merke = (host: string, wo: string) => {
    if (!gefunden.has(host)) gefunden.set(host, new Set());
    gefunden.get(host)!.add(wo);
  };
  for (const datei of [...dateien('src'), ...dateien('scripts')]) {
    for (const host of hostsIn(readFileSync(datei, 'utf8'))) merke(host, datei);
  }
  for (const host of PUSH_HOSTS_EXAKT) merke(host, 'PUSH_HOSTS_EXAKT');
  for (const endung of PUSH_HOSTS_ENDUNG) merke(`*${endung}`, 'PUSH_HOSTS_ENDUNG');
  for (const host of HANDBALL_LOGO_HOSTS) merke(host, 'HANDBALL_LOGO_HOSTS');
  return gefunden;
}

/** Zeilen der Form `| \`host\` | Art[, Art] | Zweck | Auslöser |` aus der README. */
function hostsInTabelle(readme: string, probleme: string[]): Map<string, string[]> {
  const tabelle = new Map<string, string[]>();
  for (const zeile of readme.split('\n')) {
    const m = zeile.match(/^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/);
    if (!m) continue;
    const arten = m[2].split(',').map(a => a.trim());
    // Andere Tabellen der README (Variablen, Routen) haben in Spalte zwei keine Art.
    if (!arten.every(a => ARTEN.has(a))) continue;
    const host = m[1].toLowerCase();
    if (tabelle.has(host)) probleme.push(`\`${host}\` steht doppelt in der Tabelle.`);
    tabelle.set(host, arten);
  }
  return tabelle;
}

function abweichungen(readme: string, code: Map<string, Set<string>>): string[] {
  const probleme: string[] = [];
  const tabelle = hostsInTabelle(readme, probleme);
  if (tabelle.size < 10) return [`Aus ${README} kamen nur ${tabelle.size} Hosts — das Tabellenmuster passt nicht mehr.`];
  for (const [host, wo] of [...code].sort()) {
    if (!tabelle.has(host)) probleme.push(`Neuer Host \`${host}\` (${[...wo].join(', ')}) fehlt in ${README} → „Outbound connections“.`);
  }
  for (const host of [...tabelle.keys()].sort()) {
    if (!code.has(host)) probleme.push(`\`${host}\` steht in ${README}, kommt im Code aber nicht mehr vor — Zeile entfernen.`);
  }
  return probleme;
}

describe('Ausgehende Verbindungen', () => {
  it('stehen alle in der README, und die README nennt keine verschwundenen', () => {
    expect(abweichungen(readFileSync(README, 'utf8'), hostsImCode())).toEqual([]);
  });

  it('meldet eine fehlende Zeile und einen verschwundenen Host', () => {
    const readme = readFileSync(README, 'utf8');
    const ohneTelegram = readme.split('\n').filter(z => !z.startsWith('| `api.telegram.org`')).join('\n');
    expect(abweichungen(ohneTelegram, hostsImCode())).toEqual([
      expect.stringContaining('Neuer Host `api.telegram.org`'),
    ]);
    const code = hostsImCode();
    code.delete('wa.me');
    expect(abweichungen(readme, code)).toEqual([expect.stringContaining('`wa.me` steht in README.md')]);
  });

  it('übersieht Kommentare, nicht aber Zeichenketten', () => {
    expect([...hostsIn("// siehe https://beispiel.de\nconst a = 'https://ziel.de/x';")]).toEqual(['ziel.de']);
    expect([...hostsIn('/* https://beispiel.de */ const b = `https://www.ziel.de/${x}`;')]).toEqual(['www.ziel.de']);
  });
});
