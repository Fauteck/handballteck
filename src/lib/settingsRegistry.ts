/**
 * Das Register der Einstellungen: was die Seite `/settings` kennt, wie jeder
 * Wert geprüft und in welcher Form er gespeichert wird. Der Schlüssel ist der
 * Name der Umgebungsvariable — dieselbe Zeile in `.env.example`, derselbe
 * Parser in `config.ts`. Ein Guard-Test hält Register, `.env.example` und
 * README zusammen.
 *
 * Nicht im Register stehen Variablen, die vor der Datenbank gebraucht werden
 * (`PORT`, `DATA_DIR`, `DATABASE_PATH`, `SQLITE_JOURNAL_MODE`, `TRUST_PROXY`,
 * `PUBLIC_URL`, `LOG_LEVEL`) oder einmalig gelten (`IMPORT_TODOTECK_DB`), dazu
 * das Konto der Seite selbst (`ADMIN_*`). Sie bleiben Umgebung.
 */
import { parseTeamEntries, ADMIN_PASSWORD_MIN, TEAM_GROUP_IDS } from '../config';

export type Gruppe = 'mannschaften' | 'aussehen' | 'abruf' | 'telegram' | 'microsite';
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

const kurztext = (max: number) => leerOk(t => {
  if (t.length > max) return fehler(`Höchstens ${max} Zeichen.`);
  if (/[\u0000-\u001f\u007f]/.test(t)) return fehler('Keine Steuerzeichen oder Zeilenumbrüche.');
  return ok(t);
});

const mailadresse = leerOk(t => (t.length <= 120 && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(t) ? ok(t) : fehler('Keine gültige E-Mail-Adresse.')));

export const EINSTELLUNGEN: readonly Einstellung[] = [
  {
    key: 'TEAM_IDS', gruppe: 'mannschaften', art: 'liste', label: 'Mannschaften', lang: true, zeilen: 'mannschaften', standard: '', wirkung: 'abruf',
    hinweis: 'Je Mannschaft eine Zeile, gruppiert nach Bereich: der Bereich (automatisch: aus Wettbewerb und Name gelesen), die Team-ID aus der Adresse der Mannschaftsseite auf handball.net (/team/96254), der Name, unter dem sie erscheint (leer: Bezeichnung von handball.net), ob sie wie der Verein heißt (sonst wie bei handball.net, z. B. TV Rheinbach), die Teamseite auf ClubDesk (z. B. woelfe_1) und welche Fotos von dort öffentlich stehen. Mannschaftsbild: das Gruppenbild. Spielerbilder: Porträts mit Namen; bei der Jugend werden sie nur mit diesem Häkchen überhaupt geholt. Ohne Häkchen bleiben Fotos in der Vorschau. Die Reihenfolge im Bereich ist die der Mannschaftswahl.',
    pruefe: teams,
  },
  {
    key: 'CLUB_TEAM_IDS', gruppe: 'mannschaften', art: 'liste', label: 'Mannschaften mit Vereinsname', versteckt: true, standard: '', wirkung: 'abruf',
    hinweis: 'Team-IDs, die überall (Seite, Bilder, Telegram, API) wie der Verein heißen, egal wie handball.net sie schreibt. Gepflegt mit dem Häkchen „Vereinsname“ in der Mannschaftszeile; IDs außerhalb der Tabelle (z. B. als Gegner) bleiben erhalten.',
    pruefe: teamIdListe,
  },
  { key: 'CLUB_NAME', gruppe: 'mannschaften', art: 'text', label: 'Vereinsname', standard: 'HSG Wölfe Voreifel', wirkung: 'sofort', hinweis: 'Steht oben auf jeder Seite. Mannschaften mit Häkchen „Vereinsname“ heißen überall so (Seite, Push, Feed, Bilder, Telegram, API), egal wie handball.net sie schreibt. Eine römische Ziffer („… II“) bleibt.', pruefe: kurztext(80) },
  { key: 'PRIMARY_COLOR', gruppe: 'aussehen', art: 'farbe', label: 'Hauptfarbe', standard: '#003e51', wirkung: 'sofort', hinweis: 'Farbe der Bilder und der Microsite, #rrggbb. Leer: die Farben der HSG Wölfe Voreifel.', pruefe: farbe },
  { key: 'SECONDARY_COLOR', gruppe: 'aussehen', art: 'farbe', label: 'Zweitfarbe', standard: '#015069', wirkung: 'sofort', hinweis: '#rrggbb.', pruefe: farbe },
  { key: 'ACCENT_COLOR', gruppe: 'aussehen', art: 'farbe', label: 'Akzentfarbe', standard: '#0bdbd6', wirkung: 'sofort', hinweis: '#rrggbb.', pruefe: farbe },
  {
    key: 'SYNC_INTERVAL_MS', gruppe: 'abruf', art: 'zahl', label: 'Abruf-Takt', standard: '900000', faktor: 60_000, einheit: 'Minuten', wirkung: 'naechster-takt',
    hinweis: 'Wie oft nachgesehen wird, mindestens 5 Minuten. handball.net hat keine veröffentlichte Schnittstelle: ein engerer Takt erhöht das Risiko, gesperrt zu werden.',
    pruefe: ganzzahl(5 * 60_000, 24 * 3_600_000, false, { faktor: 60_000, einheit: 'Minuten' }),
  },
  {
    key: 'SYNC_LIVE_INTERVAL_MS', gruppe: 'abruf', art: 'zahl', label: 'Live-Takt', standard: '60000', faktor: 1000, einheit: 'Sekunden', wirkung: 'naechster-takt',
    hinweis: 'Takt während eines laufenden Spiels, mindestens 20 Sekunden; 0 schaltet die Live-Ansicht aus.',
    pruefe: ganzzahl(20_000, 600_000, true, { faktor: 1000, einheit: 'Sekunden' }),
  },
  { key: 'TELEGRAM_INVITE_CODE', gruppe: 'telegram', art: 'text', label: 'Einladungscode', standard: '', wirkung: 'sofort', hinweis: 'Gesetzt abonniert nur, wer /start <code> schickt oder den Link t.me/<bot>?start=<code> öffnet. Leer: offen für jeden, der den Bot-Namen kennt.', pruefe: einladungscode },
  { key: 'TELEGRAM_ADMIN_CHAT_IDS', gruppe: 'telegram', art: 'liste', label: 'Admin-Chats', standard: '', wirkung: 'sofort', hinweis: 'Chat-IDs des Betreibers, durch Komma. Diese Chats dürfen /status, /rundruf und /erledigt und bekommen die Ausfallmeldungen. /status in irgendeinem Chat nennt die eigene ID.', pruefe: chatIds },
  { key: 'BOT_AUTO_DESCRIPTION', gruppe: 'telegram', art: 'schalter', label: 'Bot-Profiltext automatisch pflegen', standard: 'true', wirkung: 'naechster-takt', hinweis: 'Profiltext und „Was kann dieser Bot?“ aus Tabellenplatz und nächstem Spiel setzen (überschreibt den Text im BotFather).', pruefe: schalter },
  { key: 'SITE_ENABLED', gruppe: 'microsite', art: 'schalter', label: 'Microsite anbieten', standard: 'true', wirkung: 'sofort', hinweis: 'Die öffentliche Mannschaftsseite unter /<Team-ID>/. Aus: sie antwortet 404. Diese Einstellungsseite bleibt erreichbar.', pruefe: schalter },
  { key: 'SITE_PLAYERS', gruppe: 'microsite', art: 'schalter', label: 'Spielernamen zeigen', standard: 'false', wirkung: 'sofort', hinweis: 'Torjäger, Kader, Saisonkarte und Spielbericht mit Namen. Gilt für alle Mannschaften — auch für Jugendspieler; nur auf Wunsch einschalten.', pruefe: schalter },
  { key: 'SITE_PUSH_MAX', gruppe: 'microsite', art: 'zahl', label: 'Obergrenze Browser-Anmeldungen', standard: '2000', wirkung: 'sofort', hinweis: 'Darüber antwortet die Anmeldung mit 503, bis Platz ist.', pruefe: ganzzahl(1, 1_000_000) },
  { key: 'SITE_URL', gruppe: 'microsite', art: 'text', label: 'Eigene Domain der Seite', standard: '', wirkung: 'sofort', hinweis: 'Liefert ein Proxy die Seiten unter einer eigenen Domain aus, steht hier deren Wurzel (https, ohne Pfad). Webcal-Link, Feed und Vorschau zeigen dann dorthin.', pruefe: httpsWurzel(true) },
  { key: 'SITE_OPERATOR', gruppe: 'microsite', art: 'text', label: 'Betreiber (Footer)', standard: '', wirkung: 'sofort', hinweis: 'Wer die Seite betreibt; steht im Footer.', pruefe: kurztext(120) },
  { key: 'SITE_FEEDBACK_MAIL', gruppe: 'microsite', art: 'text', label: 'Rückmelde-Adresse (Footer)', standard: '', wirkung: 'sofort', hinweis: 'E-Mail-Adresse für Rückmeldungen; steht im Footer.', pruefe: mailadresse },
  { key: 'SITE_PREVIEW_TOKEN', gruppe: 'microsite', art: 'geheim', label: 'Vorschau-Schlüssel', standard: '', wirkung: 'sofort', hinweis: 'Mit /<Team-ID>/?vorab=<Schlüssel> zeigt die Seite, was noch nicht öffentlich ist. Mindestens 32 Zeichen. Wird nie angezeigt, nur ersetzt.', pruefe: vorschauSchluessel },
  { key: 'CLUBDESK_URL', gruppe: 'microsite', art: 'text', label: 'Vereinsseite bei ClubDesk', standard: '', wirkung: 'abruf', hinweis: 'Wurzel der Vereinsseite (https, ohne Pfad). Geholt wird einmal am Tag (und gleich nach einer geänderten Freigabe) das Gruppenbild und die Porträts; welche Mannschaft welche Fotos öffentlich zeigt, steht bei den Mannschaften.', pruefe: httpsWurzel(false) },
  { key: 'CLUBDESK_TEAMS', gruppe: 'mannschaften', art: 'liste', label: 'ClubDesk-Teamseiten', lang: true, versteckt: true, standard: '', wirkung: 'abruf', hinweis: 'Je Team-ID die Teamseite unter /spielbetrieb/teams-und-tabellen/, z. B. 75796=woelfe_1. Gepflegt in der Mannschaftszeile.', pruefe: clubdeskTeams },
  { key: 'TEAM_GROUPS', gruppe: 'mannschaften', art: 'liste', label: 'Bereiche', lang: true, versteckt: true, standard: '', wirkung: 'sofort', hinweis: `Je Team-ID der Bereich, wenn er nicht automatisch gelesen werden soll: 96254=jungen (${TEAM_GROUP_IDS.join(', ')}). Gepflegt in der Mannschaftszeile.`, pruefe: bereiche },
  { key: 'SITE_PHOTOS', gruppe: 'mannschaften', art: 'liste', label: 'Fotos öffentlich', lang: true, versteckt: true, standard: '', wirkung: 'abruf', hinweis: 'Je Team-ID, welche Fotos der Vereinsseite öffentlich stehen: 96254=mannschaft oder 75796=mannschaft+spieler. Gepflegt in der Mannschaftszeile.', pruefe: fotoFreigaben },
];

export const GRUPPEN: Record<Gruppe, string> = {
  mannschaften: 'Mannschaften',
  aussehen: 'Aussehen',
  abruf: 'Abruf',
  telegram: 'Telegram',
  microsite: 'Microsite',
};

/**
 * Variablen, die nur Umgebung bleiben, aber auf der Seite als Status stehen
 * (gesetzt / nicht gesetzt, nie der Wert). Der Bot-Token ist für den Umzug in
 * die Seite vorbereitet: er läuft schon über `env()`, ein Eintrag in der
 * Datenbank würde ihn also ersetzen; die Seite bietet ihn nur noch nicht an.
 */
export const STATUS_GEHEIMNISSE: readonly { key: string; label: string; hinweis: string }[] = [
  { key: 'TELEGRAM_BOT_TOKEN', label: 'Bot-Token', hinweis: 'Aus dem BotFather. Bleibt vorerst in der Umgebung; der Wechsel auf die Seite ist vorbereitet.' },
  { key: 'API_TOKEN', label: 'API-Token', hinweis: 'Für das Todoteck-Cockpit — wird dort und hier gleichzeitig geändert, deshalb nur in der Umgebung.' },
  { key: 'VAPID_PRIVATE_KEY', label: 'Web-Push-Schlüssel (VAPID)', hinweis: 'Ein Wechsel macht alle Browser-Anmeldungen ungültig; nur in der Umgebung.' },
];

export function findeEinstellung(key: string): Einstellung | undefined {
  return EINSTELLUNGEN.find(e => e.key === key);
}

/** Das Mindestmaß des Admin-Passworts, für Meldungen der Seite. */
export const PASSWORT_MIN = ADMIN_PASSWORD_MIN;
