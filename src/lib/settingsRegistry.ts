/**
 * Das Register der Einstellungen: was die Seite `/settings` kennt, wie jeder
 * Wert geprüft und in welcher Form er gespeichert wird. Der Schlüssel ist der
 * Name der Umgebungsvariable — dieselbe Zeile in `.env.example`, derselbe
 * Parser in `config.ts`. Ein Guard-Test hält Register, `.env.example` und
 * README zusammen.
 *
 * Nicht im Register stehen Variablen, die vor der Datenbank gebraucht werden
 * (`PORT`, `DATA_DIR`, `DATABASE_PATH`, `SQLITE_JOURNAL_MODE`, `TRUST_PROXY`,
 * `PUBLIC_URL`), das Schlüsselpaar für Web-Push (`VAPID_*`, ein Wechsel machte
 * alle Browser-Anmeldungen ungültig) und das Konto der Seite selbst
 * (`ADMIN_*`). Sie bleiben Umgebung. Alles andere — auch der Bot-Token — lässt
 * sich hier einstellen (entschieden 2026-11-16).
 */
import { parseTeamEntries, parseHandballClubs, ADMIN_PASSWORD_MIN, TEAM_GROUP_IDS, LOG_LEVELS } from '../config';

export type Gruppe = 'mannschaften' | 'aussehen' | 'microsite' | 'telegram' | 'fortgeschritten';
export type Art = 'text' | 'schalter' | 'zahl' | 'farbe' | 'liste' | 'geheim';
/** Wann eine Änderung greift. */
export type Wirkung = 'sofort' | 'abruf' | 'naechster-takt';

export type Pruefung = { ok: true; wert: string } | { ok: false; fehler: string };

export interface Einstellung {
  key: string;
  gruppe: Gruppe;
  art: Art;
  label: string;
  hinweis: string;
  /** Wo man die Wirkung sieht — kurz, für Laien („Microsite, Bilder, Telegram“). */
  sichtbar?: string;
  /** Feste Auswahl statt freiem Text. */
  optionen?: readonly string[];
  /** Geheimnis, das die Seite selbst zufällig erzeugen kann (Knopf „Erzeugen“). */
  erzeugbar?: boolean;
  /** Der Standard als Text — nur zur Anzeige; gerechnet wird in `config.ts`. */
  standard: string;
  wirkung: Wirkung;
  /** Mehrzeilig bearbeiten (Listen). */
  lang?: boolean;
  /** Je Eintrag eine Zeile mit eigenen Feldern statt einer Textliste: Team-ID, Anzeigename, ClubDesk-Seite, Fotos. Gespeichert wird weiter `id=Name,id`. */
  zeilen?: 'mannschaften';
  /** Kein eigenes Feld auf der Seite — der Wert wird über den Zeilen-Editor einer anderen Einstellung gepflegt. */
  versteckt?: boolean;
  /** Anzeigeeinheit bei Zahlen: der gespeicherte Wert ist in Millisekunden, die Seite zeigt Minuten/Sekunden. */
  faktor?: number;
  einheit?: string;
  /** Grenzen bei Zahlen, in der gespeicherten Einheit — die Seite setzt daraus `min`/`max` am Feld. */
  min?: number;
  max?: number;
  /** 0 ist zusätzlich erlaubt und heißt „aus“. */
  nullErlaubt?: boolean;
  pruefe: (roh: string) => Pruefung;
}

const ok = (wert: string): Pruefung => ({ ok: true, wert });
const fehler = (text: string): Pruefung => ({ ok: false, fehler: text });

const leerOk = (f: (t: string) => Pruefung) => (roh: string): Pruefung => (roh.trim() === '' ? ok('') : f(roh.trim()));

const schalter = (roh: string): Pruefung => {
  const t = roh.trim().toLowerCase();
  if (/^(true|1|ja|an|on|yes)$/.test(t)) return ok('true');
  if (/^(false|0|nein|aus|off|no)$/.test(t)) return ok('false');
  return fehler('Bitte „an“ oder „aus“ wählen.');
};

function ganzzahl(min: number, max: number, nullErlaubt = false, anzeige?: { faktor: number; einheit: string }) {
  return (roh: string): Pruefung => {
    const t = roh.trim();
    if (!/^\d{1,12}$/.test(t)) return fehler('Bitte eine ganze Zahl eingeben.');
    const n = Number(t);
    if (nullErlaubt && n === 0) return ok('0');
    if (n < min || n > max) {
      const f = anzeige?.faktor ?? 1;
      return fehler(`Erlaubt sind ${min / f} bis ${max / f}${anzeige ? ` ${anzeige.einheit}` : ''}${nullErlaubt ? ' (oder 0 für aus)' : ''}.`);
    }
    return ok(String(n));
  };
}

/** Grenzen und Prüfer einer Zahl in einem — die Seite zeigt dieselben Grenzen, die der Server prüft. */
function zahl(min: number, max: number, nullErlaubt = false, anzeige?: { faktor: number; einheit: string }) {
  return { min, max, nullErlaubt, pruefe: ganzzahl(min, max, nullErlaubt, anzeige) };
}

const farbe = leerOk(t => (/^#[0-9a-fA-F]{6}$/.test(t) ? ok(t.toLowerCase()) : fehler('Eine Farbe wie #003e51 eingeben.')));

const teams = leerOk(t => {
  const eintraege = parseTeamEntries(t);
  if (eintraege.length === 0) return fehler('Keine gültige Team-ID gefunden (Ziffern aus der Adresse auf handball.net, z. B. 96254).');
  for (const e of eintraege) {
    if (e.label && (e.label.length > 40 || /[\u0000-\u001f<>"]/.test(e.label))) return fehler(`Der Name zu ${e.id} ist zu lang oder enthält unzulässige Zeichen.`);
  }
  return ok(eintraege.map(e => (e.label ? `${e.id}=${e.label}` : e.id)).join(','));
});

const teamIdListe = leerOk(t => {
  const eintraege = parseTeamEntries(t);
  if (eintraege.length === 0) return fehler('Keine gültige Team-ID gefunden.');
  return ok(eintraege.map(e => e.id).join(','));
});

const bereiche = leerOk(t => {
  const eintraege: string[] = [];
  for (const teil of t.split(/[,;\n]+/)) {
    const x = teil.trim();
    if (!x) continue;
    const [id, bereich] = x.split('=').map(s => s?.trim().toLowerCase() ?? '');
    if (!/^\d{1,12}$/.test(id) || !(TEAM_GROUP_IDS as readonly string[]).includes(bereich)) return fehler(`„${x}“ passt nicht zu id=bereich (${TEAM_GROUP_IDS.join(', ')}).`);
    eintraege.push(`${id}=${bereich}`);
  }
  return ok(eintraege.join(','));
});

const fotoFreigaben = leerOk(t => {
  const eintraege: string[] = [];
  for (const teil of t.split(/[,;\n]+/)) {
    const x = teil.trim();
    if (!x) continue;
    const [id, rechte] = x.split('=').map(s => s?.trim().toLowerCase() ?? '');
    const teile = rechte.split('+').map(s => s.trim()).filter(Boolean);
    if (!/^\d{1,12}$/.test(id) || teile.length === 0 || teile.some(s => s !== 'mannschaft' && s !== 'spieler')) return fehler(`„${x}“ passt nicht zu id=mannschaft oder id=mannschaft+spieler.`);
    eintraege.push(`${id}=${[...new Set(teile)].sort().join('+')}`);
  }
  return ok(eintraege.join(','));
});

const httpsWurzel = (mitPfad: boolean) => leerOk(t => {
  let u: URL;
  try { u = new URL(t); } catch { return fehler('Keine gültige Adresse.'); }
  if (u.protocol !== 'https:') return fehler('Nur https-Adressen.');
  if (u.search || u.hash) return fehler('Ohne Parameter und Anker.');
  if (!mitPfad && u.pathname !== '/' && u.pathname !== '') return fehler('Nur die Wurzel, ohne Pfad.');
  return ok(mitPfad ? u.toString().replace(/\/+$/, '') : u.origin);
});

const clubdeskTeams = leerOk(t => {
  const paare: string[] = [];
  for (const teil of t.split(/[,;\n]+/)) {
    const x = teil.trim();
    if (!x) continue;
    const [id, slug] = x.split('=').map(s => s?.trim() ?? '');
    if (!/^\d{1,12}$/.test(id) || !/^[a-z0-9_-]{1,40}$/i.test(slug)) return fehler(`„${x}“ passt nicht zu id=teamseite (z. B. 75796=woelfe_1).`);
    paare.push(`${id}=${slug}`);
  }
  return paare.length > 0 ? ok(paare.join(',')) : fehler('Keine Zuordnung gefunden.');
});

const chatIds = leerOk(t => {
  const ids = t.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  if (ids.some(i => !/^-?\d{1,20}$/.test(i))) return fehler('Chat-IDs sind Zahlen, durch Komma getrennt.');
  return ok([...new Set(ids)].join(','));
});

const einladungscode = leerOk(t => (/^[A-Za-z0-9_-]{4,64}$/.test(t) ? ok(t) : fehler('4 bis 64 Zeichen: Buchstaben, Ziffern, _ und - (mehr erlaubt Telegram nicht).')));

const vorschauSchluessel = leerOk(t => (/^[A-Za-z0-9_-]{32,128}$/.test(t) ? ok(t) : fehler('Mindestens 32 Zeichen aus Buchstaben, Ziffern, _ und -; sonst bleibt die Vorschau aus.')));

/** Vereinsseiten auf handball.net: der eingefügte Link (`/club/01ufb4b?fed_id=142`) oder `01ufb4b:142`. */
export function vereinAusEingabe(roh: string): string | null {
  const t = roh.trim();
  const link = /\/club\/([a-z0-9]{3,20})\b(?:[^\s]*?[?&]fed_id=(\d{1,6}))?/i.exec(t);
  if (link) return link[2] ? `${link[1]}:${link[2]}` : null;
  return /^[a-z0-9]{3,20}:\d{1,6}$/i.test(t) ? t : null;
}

const vereine = leerOk(t => {
  const out: string[] = [];
  for (const teil of t.split(/[\s,;]+/)) {
    if (!teil.trim()) continue;
    const v = vereinAusEingabe(teil);
    if (!v) return fehler(`„${teil.trim()}“ ist kein Link auf eine Vereinsseite mit fed_id (z. B. https://www.handball.net/club/01ufb4b?fed_id=142).`);
    if (!out.includes(v)) out.push(v);
  }
  if (parseHandballClubs(out.join(',')).length !== out.length) return fehler('Vereinsangabe nicht lesbar.');
  return ok(out.join(','));
});

const botToken = leerOk(t => (/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(t) ? ok(t) : fehler('So sieht ein Token aus dem BotFather nicht aus (Zahl, Doppelpunkt, rund 35 Zeichen).')));

const einbetter = leerOk(t => {
  if (t === '*') return ok('*');
  const out: string[] = [];
  for (const teil of t.split(/[\s,;]+/)) {
    if (!teil) continue;
    let u: URL;
    try { u = new URL(teil); } catch { return fehler(`„${teil}“ ist keine Adresse.`); }
    if (u.protocol !== 'https:') return fehler(`„${teil}“: nur https-Adressen.`);
    if (!out.includes(u.origin)) out.push(u.origin);
  }
  return ok(out.join(','));
});

const auswahl = (werte: readonly string[]) => leerOk(t => (werte.includes(t.toLowerCase()) ? ok(t.toLowerCase()) : fehler(`Erlaubt: ${werte.join(', ')}.`)));

const kurztext = (max: number) => leerOk(t => {
  if (t.length > max) return fehler(`Höchstens ${max} Zeichen.`);
  if (/[\u0000-\u001f\u007f]/.test(t)) return fehler('Keine Steuerzeichen oder Zeilenumbrüche.');
  return ok(t);
});

const mailadresse = leerOk(t => (t.length <= 120 && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(t) ? ok(t) : fehler('Keine gültige E-Mail-Adresse.')));

export const EINSTELLUNGEN: readonly Einstellung[] = [
  // --- Mannschaften ---------------------------------------------------------
  {
    key: 'TEAM_IDS', gruppe: 'mannschaften', art: 'liste', label: 'Mannschaften', lang: true, zeilen: 'mannschaften', standard: '', wirkung: 'abruf',
    sichtbar: 'Microsite, Telegram, Kalender, Feed',
    hinweis: 'Jede Zeile ist eine Mannschaft, die Handballteck verfolgt. Am einfachsten über „Saisonwechsel und Vereinsliste“ unten — oder den Link der Mannschaftsseite auf handball.net (…/team/96254) ins Feld Team-ID einfügen; die Nummer wird herausgelöst. Name: wie die Mannschaft auf Seite und im Bot heißt (leer: aus Liga und Altersklasse, z. B. „B-Jugend“). Bereich: unter welcher Überschrift sie in der Mannschaftswahl steht (leer: automatisch). ClubDesk-Seite: woher die Fotos kommen (Link der Teamseite einfügen genügt). Mannschaftsbild: das Gruppenbild. Spielerbilder: Porträts mit Namen; bei der Jugend werden sie nur mit diesem Häkchen überhaupt geholt. Ohne Häkchen bleiben Fotos in der Vorschau. Die Reihenfolge im Bereich ist die der Mannschaftswahl.',
    pruefe: teams,
  },
  {
    key: 'HANDBALL_CLUBS', gruppe: 'mannschaften', art: 'liste', label: 'Vereinsseiten bei handball.net', lang: true, standard: '', wirkung: 'sofort',
    sichtbar: 'nur hier: Saisonwechsel und Vereinsliste',
    hinweis: 'Je Zeile der Link auf eine Vereinsseite bei handball.net, so wie er im Browser steht (z. B. https://www.handball.net/club/01ufb4b?fed_id=142 — das „fed_id“ gehört dazu). Daraus liest „Saisonwechsel und Vereinsliste“ alle Mannschaften des Vereins. Bei einer Spielvereinigung auch die Stammvereine eintragen, solange Mannschaften noch unter deren Namen antreten. Ändert an Seite und Bot nichts.',
    pruefe: vereine,
  },
  {
    key: 'CLUB_TEAM_IDS', gruppe: 'mannschaften', art: 'liste', label: 'Vereinsmannschaften unter fremdem Namen', standard: '', wirkung: 'abruf',
    sichtbar: 'Spielpläne, Tabellen, Bilder, Telegram',
    hinweis: 'Team-IDs von Mannschaften des Vereins, die Handballteck nicht selbst verfolgt (sie stehen oben nicht in der Tabelle), die aber als Gegner oder in Tabellen auftauchen und bei handball.net noch unter dem Namen eines Stammvereins laufen. Sie erscheinen dann überall unter dem Vereinsnamen. Die Mannschaften in der Tabelle heißen ohnehin so.',
    pruefe: teamIdListe,
  },
  { key: 'CLUB_NAME', gruppe: 'mannschaften', art: 'text', label: 'Vereinsname', standard: 'HSG Wölfe Voreifel', wirkung: 'sofort', sichtbar: 'Microsite, Push, Feed, Bilder, Telegram', hinweis: 'Der Name, unter dem die eigenen Mannschaften überall erscheinen — egal, wie handball.net sie schreibt. Eine römische Ziffer („… II“) bleibt erhalten.', pruefe: kurztext(80) },
  { key: 'CLUBDESK_TEAMS', gruppe: 'mannschaften', art: 'liste', label: 'ClubDesk-Teamseiten', lang: true, versteckt: true, standard: '', wirkung: 'abruf', hinweis: 'Je Team-ID die Teamseite unter /spielbetrieb/teams-und-tabellen/, z. B. 75796=woelfe_1. Gepflegt in der Mannschaftszeile.', pruefe: clubdeskTeams },
  { key: 'TEAM_GROUPS', gruppe: 'mannschaften', art: 'liste', label: 'Bereiche', lang: true, versteckt: true, standard: '', wirkung: 'sofort', hinweis: `Je Team-ID der Bereich, wenn er nicht automatisch gelesen werden soll: 96254=jungen (${TEAM_GROUP_IDS.join(', ')}). Gepflegt in der Mannschaftszeile.`, pruefe: bereiche },
  { key: 'SITE_PHOTOS', gruppe: 'mannschaften', art: 'liste', label: 'Fotos öffentlich', lang: true, versteckt: true, standard: '', wirkung: 'abruf', hinweis: 'Je Team-ID, welche Fotos der Vereinsseite öffentlich stehen: 96254=mannschaft oder 75796=mannschaft+spieler. Gepflegt in der Mannschaftszeile.', pruefe: fotoFreigaben },
  // --- Aussehen -------------------------------------------------------------
  { key: 'PRIMARY_COLOR', gruppe: 'aussehen', art: 'farbe', label: 'Hauptfarbe', standard: '#003e51', wirkung: 'sofort', sichtbar: 'Microsite, Bilder im Bot', hinweis: 'Grundfarbe von Kopf, Flächen und Bildern. Am besten mit dem Farbfeld rechts wählen; die Vorschau unten prüft, ob weiße Schrift darauf gut lesbar ist. Leer: die Farben der HSG Wölfe Voreifel.', pruefe: farbe },
  { key: 'SECONDARY_COLOR', gruppe: 'aussehen', art: 'farbe', label: 'Zweitfarbe', standard: '#015069', wirkung: 'sofort', sichtbar: 'Microsite, Bilder im Bot', hinweis: 'Für Bänder und Zwischenflächen, meist eine Abstufung der Hauptfarbe.', pruefe: farbe },
  { key: 'ACCENT_COLOR', gruppe: 'aussehen', art: 'farbe', label: 'Akzentfarbe', standard: '#0bdbd6', wirkung: 'sofort', sichtbar: 'Microsite, Bilder im Bot', hinweis: 'Für Knöpfe und Hervorhebungen — sie soll sich deutlich von der Hauptfarbe abheben.', pruefe: farbe },
  // --- Microsite ------------------------------------------------------------
  { key: 'SITE_ENABLED', gruppe: 'microsite', art: 'schalter', label: 'Microsite anbieten', standard: 'true', wirkung: 'sofort', sichtbar: 'Microsite', hinweis: 'Die öffentliche Mannschaftsseite unter /<Team-ID>/ mit Spielplan, Tabelle, Kalender-Abo und Benachrichtigungen. Aus: Besucher bekommen „nicht gefunden“. Diese Einstellungsseite bleibt erreichbar.', pruefe: schalter },
  { key: 'SITE_OPERATOR', gruppe: 'microsite', art: 'text', label: 'Betreiber (Footer)', standard: '', wirkung: 'sofort', sichtbar: 'Fußzeile der Microsite', hinweis: 'Wer die Seite betreibt, z. B. der Verein oder die verantwortliche Person.', pruefe: kurztext(120) },
  { key: 'SITE_FEEDBACK_MAIL', gruppe: 'microsite', art: 'text', label: 'Rückmelde-Adresse (Footer)', standard: '', wirkung: 'sofort', sichtbar: 'Fußzeile der Microsite', hinweis: 'E-Mail-Adresse, an die Besucher Fehler und Wünsche schicken können.', pruefe: mailadresse },
  {
    key: 'SITE_FRAME_ANCESTORS', gruppe: 'microsite', art: 'liste', label: 'Einbetten erlauben (Vereinsseite)', standard: '', wirkung: 'sofort', sichtbar: 'Vereinsseite (iframe)',
    hinweis: 'Die Adressen der Vereinsseite, die die Microsite in einem Rahmen (iframe) zeigen darf, durch Komma, z. B. https://woelfe-voreifel.de, https://www.woelfe-voreifel.de (mit und ohne www sind zwei). Leer: niemand. Den fertigen Block zum Einfügen zeigt „Einbetten“ unten. Nur zum Testen: ein einzelner Stern (*) erlaubt jede Seite. Einstellungsseite und Bot-Webhook lassen sich nie einbetten.',
    pruefe: einbetter,
  },
  { key: 'SITE_URL', gruppe: 'microsite', art: 'text', label: 'Eigene Domain der Seite', standard: '', wirkung: 'sofort', sichtbar: 'Kalender-Link, Feed, Link-Vorschau', hinweis: 'Nur nötig, wenn die Microsite unter einer anderen Adresse erreichbar sein soll als dieser Dienst (ein Proxy leitet sie weiter). Dann hier deren Wurzel (https, ohne Pfad). Sonst leer lassen.', pruefe: httpsWurzel(true) },
  { key: 'SITE_PREVIEW_TOKEN', gruppe: 'microsite', art: 'geheim', erzeugbar: true, label: 'Vorschau-Schlüssel', standard: '', wirkung: 'sofort', sichtbar: 'nur mit dem Vorschau-Link', hinweis: 'Schaltet eine geheime Vorschau frei: Mit ihr zeigt die Microsite auch, was noch nicht öffentlich ist (Fotos ohne Freigabe). „Erzeugen“ wählt einen sicheren Schlüssel; nach dem Speichern öffnet „Vorschau öffnen“ oben die Seite. Wird nie angezeigt, nur ersetzt.', pruefe: vorschauSchluessel },
  { key: 'CLUBDESK_URL', gruppe: 'microsite', art: 'text', label: 'Vereinsseite bei ClubDesk', standard: '', wirkung: 'abruf', sichtbar: 'Fotos auf der Microsite', hinweis: 'Die Adresse der Vereinsseite bei ClubDesk (https, ohne Pfad), z. B. https://woelfevoreifel.clubdesk.com. Von dort holt Handballteck einmal am Tag Mannschaftsbild und Porträts. Welche Mannschaft welche Fotos öffentlich zeigt, steht bei den Mannschaften. Leer: keine Fotos.', pruefe: httpsWurzel(false) },
  // --- Telegram -------------------------------------------------------------
  { key: 'TELEGRAM_BOT_TOKEN', gruppe: 'telegram', art: 'geheim', label: 'Bot-Token', standard: '', wirkung: 'sofort', sichtbar: 'Telegram-Bot', hinweis: 'Der Schlüssel des Bots aus dem BotFather in Telegram (/newbot oder /token), z. B. 123456789:AA… „Token prüfen“ fragt Telegram, welcher Bot dazu gehört — gespeichert wird erst mit „Speichern“, danach meldet sich der Bot sofort an. Leer: kein Bot; die Microsite läuft trotzdem. Wird nie angezeigt, nur ersetzt.', pruefe: botToken },
  { key: 'TELEGRAM_INVITE_CODE', gruppe: 'telegram', art: 'text', label: 'Einladungscode', standard: '', wirkung: 'sofort', sichtbar: 'Einladungslink, QR-Code', hinweis: 'Gesetzt, kann nur abonnieren, wer den Einladungslink (unten, auch als QR-Code) bekommen hat. Leer: jeder, der den Bot-Namen kennt.', pruefe: einladungscode },
  { key: 'TELEGRAM_ADMIN_CHAT_IDS', gruppe: 'telegram', art: 'liste', label: 'Admin-Chats', standard: '', wirkung: 'sofort', sichtbar: 'Telegram (nur Betreiber)', hinweis: 'Wer den Bot betreibt: Diese Chats bekommen Störungsmeldungen und Rückmeldungen und dürfen /status, /rundruf und /erledigt. Am einfachsten dem Bot /start schicken und dann unten „Aus den Abonnenten wählen“. Wer die eigene Nummer (Chat-ID) braucht: /status an den Bot schicken. In einer eingetragenen Gruppe dürfen die Befehle nur Mitglieder, die selbst eingetragen sind.', pruefe: chatIds },
  { key: 'BOT_AUTO_DESCRIPTION', gruppe: 'telegram', art: 'schalter', label: 'Bot-Profiltext automatisch pflegen', standard: 'true', wirkung: 'naechster-takt', sichtbar: 'Profil des Bots in Telegram', hinweis: 'Schreibt Tabellenplatz und nächstes Spiel in Profiltext und „Was kann dieser Bot?“ — überschreibt dafür den Text aus dem BotFather. Aus: der Text bleibt, wie er im BotFather steht.', pruefe: schalter },
  // --- Fortgeschritten ------------------------------------------------------
  {
    key: 'SYNC_INTERVAL_MS', gruppe: 'fortgeschritten', art: 'zahl', label: 'Abruf-Takt', standard: '900000', faktor: 60_000, einheit: 'Minuten', wirkung: 'naechster-takt', sichtbar: 'Aktualität aller Daten',
    hinweis: 'Wie oft Handballteck bei handball.net nachsieht, mindestens 5 Minuten. Ohnehin geholt wird einmal am Tag und am Spieltag nach dem Spiel. handball.net hat keine offizielle Schnittstelle: Ein engerer Takt erhöht das Risiko, gesperrt zu werden.',
    ...zahl(5 * 60_000, 24 * 3_600_000, false, { faktor: 60_000, einheit: 'Minuten' }),
  },
  {
    key: 'SYNC_LIVE_INTERVAL_MS', gruppe: 'fortgeschritten', art: 'zahl', label: 'Live-Takt', standard: '60000', faktor: 1000, einheit: 'Sekunden', wirkung: 'naechster-takt', sichtbar: 'Live-Ansicht der Microsite',
    hinweis: 'Wie oft während eines laufenden Spiels nachgesehen wird, mindestens 20 Sekunden. 0 schaltet die Live-Ansicht aus.',
    ...zahl(20_000, 600_000, true, { faktor: 1000, einheit: 'Sekunden' }),
  },
  { key: 'SITE_PUSH_MAX', gruppe: 'fortgeschritten', art: 'zahl', label: 'Obergrenze Browser-Benachrichtigungen', standard: '2000', wirkung: 'sofort', sichtbar: 'Microsite (Glocke)', hinweis: 'So viele Browser können sich insgesamt für Benachrichtigungen anmelden. Darüber lehnt die Seite neue Anmeldungen ab, bis wieder Platz ist — Schutz vor einer überlaufenden Datenbank.', ...zahl(1, 1_000_000) },
  { key: 'LOG_LEVEL', gruppe: 'fortgeschritten', art: 'text', optionen: LOG_LEVELS, label: 'Ausführlichkeit des Logs', standard: 'info', wirkung: 'sofort', sichtbar: 'nur im Container-Log', hinweis: 'Wie viel der Dienst ins Log schreibt. info ist der Normalfall; debug nur zur Fehlersuche, warn oder error für ein ruhiges Log.', pruefe: auswahl(LOG_LEVELS) },
];

export const GRUPPEN: Record<Gruppe, string> = {
  mannschaften: 'Mannschaften',
  aussehen: 'Aussehen',
  microsite: 'Microsite',
  telegram: 'Telegram',
  fortgeschritten: 'Fortgeschritten',
};

/**
 * Was nur Umgebung bleibt, aber auf der Seite als Status steht (gesetzt / nicht
 * gesetzt, nie der Wert).
 */
export const STATUS_GEHEIMNISSE: readonly { key: string; label: string; hinweis: string }[] = [
  { key: 'VAPID_PRIVATE_KEY', label: 'Schlüssel für Browser-Benachrichtigungen (VAPID)', hinweis: 'Entsteht beim ersten Bedarf von selbst und liegt in der Datenbank. Ein Wechsel machte alle Browser-Anmeldungen ungültig; deshalb nicht hier.' },
];

export function findeEinstellung(key: string): Einstellung | undefined {
  return EINSTELLUNGEN.find(e => e.key === key);
}

/** Das Mindestmaß des Admin-Passworts, für Meldungen der Seite. */
export const PASSWORT_MIN = ADMIN_PASSWORD_MIN;
