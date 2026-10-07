/**
 * Handball-Telegram-Bot (Wiki „Handball-Verfolgung (handball.net)“ §5).
 *
 * Geprüft wird, was in Betrieb peinlich würde: dass ein Fremder ohne
 * Einladungscode nichts abonniert, dass Befehle nur Abonnenten antworten,
 * dass jede Meldung je Spiel genau einmal rausgeht, dass der Endstand die
 * Torschützen nach Nummer nennt, dass alte Endstände beim ersten Lauf nicht
 * nachgeliefert werden und dass ein blockierender Chat aus der Liste fliegt.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { unlinkSync } from 'fs';
import { eq } from 'drizzle-orm';

const DB_FILE = `/tmp/handball-bot-test-${process.pid}.db`;
process.env.DATABASE_PATH = DB_FILE;
process.env.PUBLIC_URL = 'https://todo.test.local';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_INVITE_CODE;
delete process.env.TELEGRAM_ADMIN_CHAT_IDS;
delete process.env.TEAM_IDS;
delete process.env.PRIMARY_COLOR; delete process.env.SECONDARY_COLOR; delete process.env.ACCENT_COLOR;
delete process.env.SITE_URL; delete process.env.SITE_PLAYERS; delete process.env.SITE_ENABLED;
delete process.env.SITE_OPERATOR; delete process.env.SITE_FEEDBACK_MAIL;

const TEAM = '96254';

let dbRef: typeof import('../db')['db'];
let schemaRef: typeof import('../db/schema');
let bot: typeof import('../lib/handballBot');
let TelegramApiError: typeof import('../lib/telegramClient')['TelegramApiError'];
const ORIGINAL_FETCH = global.fetch;

function antwort(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status, headers: { 'Content-Type': typeof body === 'string' ? 'text/html' : 'application/json' },
  });
}

/** Ein fetch nur für die Aufstellung; alles andere kommt aus der Datenbank. */
function aufstellungsQuelle(players: Array<Record<string, unknown>>) {
  const f = vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    if (!u.includes('/api/new/')) return Promise.resolve(antwort('<html><head><meta name="client-token" content="tok"></head></html>'));
    if (u.includes('/lineups')) {
      return Promise.resolve(antwort({ data: {
        local: { team: { id: 96254, name: 'HSG WÖLFE VOREIFEL' }, players, staff: [{ number: 0, is_staff: true }] },
        visitor: { team: { id: 96300, name: 'HV ERFTSTADT' }, players: [], staff: [] },
      } }));
    }
    return Promise.resolve(antwort({ error: 'nope' }, 404));
  });
  global.fetch = f as unknown as typeof fetch;
  return f;
}

function sammler() {
  const gesendet: Array<{ chatId: string; text: string; keyboard?: unknown }> = [];
  const deps = { send: vi.fn(async (chatId: string, text: string, keyboard?: unknown) => { gesendet.push({ chatId, text, keyboard }); }) };
  return { deps, gesendet };
}

function update(text: string, chatId: number | string = 4711, updateId = Math.floor(Math.random() * 1e9)) {
  return { update_id: updateId, message: { message_id: 1, from: { id: Number(chatId) || 1, first_name: 'Kumpel' }, chat: { id: chatId as number, type: 'private' }, text } };
}

function gruppenUpdate(text: string, chatId = -100123, title = 'Eltern B-Jugend') {
  return { update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, from: { id: 4711, first_name: 'Kumpel' }, chat: { id: chatId, type: 'supergroup', title }, text } };
}

/**
 * Ein fetch für alles, was der Bot nach draußen fragt — je Pfad eine
 * Antwort; was nicht genannt ist, bekommt 404.
 */
function quelle(routen: Record<string, unknown>) {
  const f = vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    if (!u.includes('/api/new/')) return Promise.resolve(antwort('<html><head><meta name="client-token" content="tok"></head></html>'));
    for (const [pfad, body] of Object.entries(routen)) {
      if (u.includes(pfad)) return Promise.resolve(antwort(body));
    }
    return Promise.resolve(antwort({ error: 'nope' }, 404));
  });
  global.fetch = f as unknown as typeof fetch;
  return f;
}

/**
 * Die Konfiguration kommt aus der Umgebung (config.ts). `extra` nimmt die
 * alten Feldnamen der Todoteck-Dienste-Zeile entgegen, damit die Tests
 * lesbar bleiben; `token` setzt TELEGRAM_BOT_TOKEN.
 */
function trageTeamEin(extra: Record<string, unknown> = {}, token: string | null = null) {
  const setze = (name: string, wert: unknown) => { if (wert === undefined || wert === null || wert === '') delete process.env[name]; else process.env[name] = String(wert); };
  setze('TEAM_IDS', extra.team_ids ?? TEAM);
  setze('TELEGRAM_INVITE_CODE', extra.bot_invite_code);
  setze('TELEGRAM_ADMIN_CHAT_IDS', extra.bot_admin_chat_id);
  setze('BOT_AUTO_DESCRIPTION', extra.bot_auto_description);
  setze('PRIMARY_COLOR', extra.primary_color);
  setze('SECONDARY_COLOR', extra.secondary_color);
  setze('ACCENT_COLOR', extra.accent_color);
  setze('TELEGRAM_BOT_TOKEN', token);
}

function konfigurationLeeren() {
  for (const name of ['TEAM_IDS', 'TELEGRAM_INVITE_CODE', 'TELEGRAM_ADMIN_CHAT_IDS', 'BOT_AUTO_DESCRIPTION', 'PRIMARY_COLOR', 'SECONDARY_COLOR', 'ACCENT_COLOR', 'TELEGRAM_BOT_TOKEN']) delete process.env[name];
}

/** Telegram-API und handball.net-Seite in einem fetch — zählt die Telegram-Methoden. */
function telegramQuelle() {
  const methoden: string[] = [];
  const f = vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    const m = /api\.telegram\.org\/bot[^/]+\/(\w+)/.exec(u);
    if (m) {
      methoden.push(m[1]);
      const result = m[1] === 'getMe' ? { id: 1, username: 'woelfe_bot' } : true;
      return Promise.resolve(antwort({ ok: true, result }));
    }
    return Promise.resolve(antwort('<html></html>'));
  });
  global.fetch = f as unknown as typeof fetch;
  return methoden;
}

function legeSpiel(over: Partial<Record<string, unknown>> = {}) {
  const startsAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const id = String(over.match_id ?? 'm1');
  dbRef.insert(schemaRef.handball_team_match).values({
    id: `${TEAM}:${id}`, team_id: TEAM, match_id: id, season_id: 2627,
    starts_at: startsAt, status: 'scheduled', status_name: 'Pendiente', round: 4, phase_id: 12800,
    competition_name: 'Kreisoberliga mB', championship_name: 'B-Jugend',
    home_id: TEAM, home_name: 'HSG Wölfe Voreifel', away_id: '96300', away_name: 'HV Erftstadt',
    score_home: null, score_away: null, venue_name: 'Sporthalle Heimerzheim', venue_address: 'Schulstrasse 1, 53913 Swisttal',
    notified_upcoming: false, notified_result: false, updated_at: new Date().toISOString(),
    ...over,
  } as never).run();
}

function legeTabelle() {
  dbRef.insert(schemaRef.handball_standings).values({
    phase_id: 12800, season_id: 2627, competition_name: 'Kreisoberliga mB', fetched_at: new Date().toISOString(),
    payload: JSON.stringify([
      { round: 3, position: 1, teamId: TEAM, teamName: 'HSG Wölfe Voreifel', played: 3, won: 3, drawn: 0, lost: 0, goalsFor: 106, goalsAgainst: 87, goalsDiff: 19, points: 6 },
      { round: 3, position: 2, teamId: '96300', teamName: 'HV Erftstadt', played: 3, won: 2, drawn: 0, lost: 1, goalsFor: 80, goalsAgainst: 70, goalsDiff: 10, points: 4 },
    ]),
  }).run();
}

function legeKader() {
  const now = new Date().toISOString();
  for (const [pid, vor, nach, nr] of [['p-lieck', 'Eskil', 'Lieck', 25], ['p-schuessler', 'Finn', 'Schüssler', 23], ['p-raab', 'Jan', 'Raab', 21]] as const) {
    dbRef.insert(schemaRef.handball_roster).values({
      id: `${TEAM}:${pid}`, team_id: TEAM, player_id: pid, first_name: vor, last_name: nach, number: nr, role: 'player', season_id: 2627, updated_at: now,
    }).run();
  }
  dbRef.insert(schemaRef.handball_roster).values({
    id: `${TEAM}:p-kalenborn`, team_id: TEAM, player_id: 'p-kalenborn', first_name: 'Frank', last_name: 'Kalenborn', number: null, role: 'staff', season_id: 2627, updated_at: now,
  }).run();
}

function abonniere(chatId = '4711') {
  const now = new Date().toISOString();
  dbRef.insert(schemaRef.handball_bot_subscriber).values({ chat_id: chatId, name: 'Kumpel', subscribed_at: now, last_seen_at: now }).run();
}

beforeAll(async () => {
  const { runMigrations } = await import('../db/migrate');
  const { db } = await import('../db');
  const schema = await import('../db/schema');
  ({ TelegramApiError } = await import('../lib/telegramClient'));
  bot = await import('../lib/handballBot');
  runMigrations();
  dbRef = db;
  schemaRef = schema;
});

afterAll(() => {
  global.fetch = ORIGINAL_FETCH;
  try { unlinkSync(DB_FILE); } catch { /* egal */ }
});

beforeEach(async () => {
  bot.__resetHandballBotForTests();
  const { __resetHandballTokenForTests } = await import('../lib/handballNetClient');
  __resetHandballTokenForTests();
  global.fetch = ORIGINAL_FETCH;
  konfigurationLeeren();
  dbRef.delete(schemaRef.handball_bot_instance).run();
  dbRef.delete(schemaRef.handball_team_match).run();
  dbRef.delete(schemaRef.handball_standings).run();
  dbRef.delete(schemaRef.handball_roster).run();
  dbRef.delete(schemaRef.handball_match_player).run();
  dbRef.delete(schemaRef.handball_bot_delivery).run();
  dbRef.delete(schemaRef.handball_match_change).run();
  dbRef.delete(schemaRef.handball_bot_subscriber).run();
  dbRef.delete(schemaRef.handball_bot_sent).run();
  dbRef.delete(schemaRef.handball_bot_feedback).run();
  trageTeamEin();
});

describe('Abonnieren', () => {
  it('/start trägt ein und erklärt sich', async () => {
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/start'), deps);
    expect(bot.listSubscribers()).toHaveLength(1);
    expect(gesendet[0].text).toContain('Willkommen');
    expect(gesendet[0].text).toContain('/tabelle');
  });

  it('fragt bei mehreren Mannschaften zuerst, welche — und meldet bis dahin nichts', async () => {
    trageTeamEin({ team_ids: `${TEAM},75796` });
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/start'), deps);
    expect(bot.listSubscribers()[0].teamIds).toEqual([]);
    expect(bot.verfolgt(bot.listSubscribers()[0], TEAM)).toBe(false);
    expect(gesendet[1].text).toContain('Welche Mannschaften willst du verfolgen?');
    const knoepfe = (gesendet[1].keyboard as { inline_keyboard: Array<Array<{ text: string }>> } | undefined)?.inline_keyboard.flat().map(k => k.text) ?? [];
    expect(knoepfe.filter(t => t.startsWith('▫️'))).toHaveLength(2);

    // Ein Befehl ohne Auswahl bringt die Auswahl, /hilfe nicht.
    await bot.handleHandballUpdate(update('/tabelle'), deps);
    expect(gesendet.at(-1)?.text).toContain('Welche Mannschaften');
    await bot.handleHandballUpdate(update('/hilfe'), deps);
    expect(gesendet.at(-1)?.text).toContain('/tabelle');

    await bot.handleHandballUpdate(update(`/teams ${TEAM}`), deps);
    expect(bot.listSubscribers()[0].teamIds).toEqual([TEAM]);
    expect(bot.verfolgt(bot.listSubscribers()[0], TEAM)).toBe(true);
    expect(bot.verfolgt(bot.listSubscribers()[0], '75796')).toBe(false);
  });

  it('lässt bestehende Abonnenten ohne Auswahl bei allen Mannschaften', async () => {
    trageTeamEin({ team_ids: `${TEAM},75796` });
    dbRef.insert(schemaRef.handball_bot_subscriber).values({ chat_id: '4711', name: 'Alt', subscribed_at: '2026-09-01T00:00:00Z', last_seen_at: '2026-09-01T00:00:00Z' }).run();
    const { deps } = sammler();
    await bot.handleHandballUpdate(update('/start'), deps);
    expect(bot.listSubscribers()[0].teamIds).toBeNull();
  });

  it('verlangt den Einladungscode, wenn einer gesetzt ist', async () => {
    process.env.TELEGRAM_INVITE_CODE = 'woelfe';
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/start'), deps);
    expect(bot.listSubscribers()).toHaveLength(0);
    expect(gesendet[0].text).toContain('nicht öffentlich');
    await bot.handleHandballUpdate(update('/start woelfe'), deps);
    expect(bot.listSubscribers()).toHaveLength(1);
  });

  it('antwortet Fremden nur mit dem Hinweis auf /start', async () => {
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/tabelle'), deps);
    expect(gesendet[0].text).toContain('/start');
    expect(gesendet[0].text).not.toContain('Kreisoberliga');
  });

  it('/stop trägt aus, ein wiederholtes Update wird verworfen', async () => {
    abonniere();
    const { deps, gesendet } = sammler();
    const u = update('/stop', 4711, 42);
    await bot.handleHandballUpdate(u, deps);
    await bot.handleHandballUpdate(u, deps);
    expect(bot.listSubscribers()).toHaveLength(0);
    expect(gesendet).toHaveLength(1);
  });
});

describe('Befehle', () => {
  it('/spiele, /ergebnisse und /tabelle antworten aus der Datenbank', async () => {
    abonniere();
    legeSpiel();
    legeSpiel({ match_id: 'alt', starts_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), status: 'finished', score_home: 30, score_away: 22 });
    legeTabelle();
    const f = vi.fn();
    global.fetch = f as unknown as typeof fetch;
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/spiele'), deps);
    await bot.handleHandballUpdate(update('/ergebnisse'), deps);
    await bot.handleHandballUpdate(update('/tabelle'), deps);
    expect(gesendet[0].text).toContain('nächste Spiele');
    expect(gesendet[0].text).toContain('H HV Erftstadt');
    expect(gesendet[1].text).toContain('✅');
    expect(gesendet[1].text).toContain('30:22');
    // Ohne Bild-Weg (Tests) kommt die Textfassung.
    expect(gesendet[2].text).toContain('<pre>');
    expect(gesendet[2].text).toContain('▶ 1 HSG Wölfe Voreifel');
    expect(gesendet[2].text).toContain('nach dem 3. Spieltag');
    // Kein Aufruf nach draußen für Befehle.
    expect(f).not.toHaveBeenCalled();
  });

  it('/kader zeigt Namen mit Nummern und den Stab', async () => {
    abonniere();
    legeKader();
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/kader'), deps);
    expect(gesendet[0].text).toContain('Kader (3 Spieler)');
    expect(gesendet[0].text).toContain('21  Jan Raab');
    expect(gesendet[0].text).toContain('Trainer: Frank Kalenborn');
  });

  it('/kader geht als Bild, wenn ein Bild-Weg da ist — mit Textfassung als Rückfall', async () => {
    abonniere();
    legeKader();
    const fotos: Array<{ chatId: string; png: Buffer; caption: string; filename?: string }> = [];
    const { deps, gesendet } = sammler();
    const mitBild = { ...deps, sendPhoto: vi.fn(async (chatId: string, png: Buffer, caption: string, filename?: string) => { fotos.push({ chatId, png, caption, filename }); }) };
    await bot.handleHandballUpdate(update('/kader'), mitBild);
    expect(fotos).toHaveLength(1);
    expect(fotos[0].png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(fotos[0].caption).toContain('Kader (3 Spieler)');
    expect(fotos[0].filename).toBe('kader.png');
    expect(gesendet).toHaveLength(0);

    const kaputt = { ...deps, sendPhoto: vi.fn(async () => { throw new Error('Telegram mag das Bild nicht'); }) };
    await bot.handleHandballUpdate(update('/kader'), kaputt);
    expect(gesendet).toHaveLength(1);
    expect(gesendet[0].text).toContain('21  Jan Raab');
  });

  it('/kader ohne geholten Kader sagt das als Text, auch mit Bild-Weg', async () => {
    abonniere();
    const fotos: Buffer[] = [];
    const { deps, gesendet } = sammler();
    const mitBild = { ...deps, sendPhoto: vi.fn(async (_c: string, png: Buffer) => { fotos.push(png); }) };
    await bot.handleHandballUpdate(update('/kader'), mitBild);
    expect(fotos).toHaveLength(0);
    expect(gesendet[0].text).toContain('Kader noch nicht geholt');
  });

  it('sagt ohne Aufstellungsnamen, dass der Kader fehlt', () => {
    const team = { team_id: TEAM, name: 'HSG Wölfe Voreifel', label: 'HSG Wölfe Voreifel', championship_name: null, next_match: null, last_match: null, matches: [], standings: [] };
    const m = {
      match_id: 'm1', season_id: 2627, starts_at: new Date().toISOString(), status: 'scheduled', status_name: '', round: 1, competition_name: 'Kreisoberliga mB',
      home_id: TEAM, home_name: 'HSG Wölfe Voreifel', away_id: '96300', away_name: 'HV Erftstadt', is_home: true, score_home: null, score_away: null, won: null, rated: false,
      halftime_home: null, halftime_away: null, venue_name: null, venue_address: null, venue_lat: null, venue_lon: null, report_url: null, report_text: null, events: null, url: 'u',
    };
    const seite = { teamId: TEAM, teamName: 'HSG Wölfe Voreifel', staffCount: 0, players: [{ playerId: 'x', number: 7, isGoalkeeper: false, isCaptain: false, goals: 0, sevenMeterGoals: 0, sevenMeterAttempts: 0, twoMinutes: 0 }] };
    expect(bot.textAufstellung(team, m, seite)).toContain('Namen fehlen noch');
  });

  it('/tabelle geht als Bild, wenn ein Bild-Weg da ist — mit Textfassung als Rückfall', async () => {
    abonniere();
    legeSpiel();
    legeTabelle();
    const fotos: Array<{ chatId: string; png: Buffer; caption: string }> = [];
    const { deps, gesendet } = sammler();
    const mitBild = { ...deps, sendPhoto: vi.fn(async (chatId: string, png: Buffer, caption: string) => { fotos.push({ chatId, png, caption }); }) };
    await bot.handleHandballUpdate(update('/tabelle'), mitBild);
    expect(fotos).toHaveLength(1);
    // PNG-Signatur.
    expect(fotos[0].png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(fotos[0].caption).toContain('nach dem 3. Spieltag');
    expect(gesendet).toHaveLength(0);

    const kaputt = { ...deps, sendPhoto: vi.fn(async () => { throw new Error('Telegram mag das Bild nicht'); }) };
    await bot.handleHandballUpdate(update('/tabelle'), kaputt);
    expect(gesendet).toHaveLength(1);
    expect(gesendet[0].text).toContain('<pre>');
  });

  it('kennt unbekannte Befehle und Freitext, ohne zu stolpern', async () => {
    abonniere();
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/wetter'), deps);
    await bot.handleHandballUpdate(update('hallo'), deps);
    expect(gesendet[0].text).toContain('kenne ich nicht');
    expect(gesendet[1].text).toContain('nur Befehle');
  });
});

describe('Meldungen', () => {
  it('kündigt eine Stunde vorher an — je Spiel einmal, an alle', async () => {
    abonniere('1'); abonniere('2');
    legeSpiel({ starts_at: new Date(Date.now() + 50 * 60 * 1000).toISOString() });
    // Der Spielplan des Gegners (ein Abruf je Ankündigung) antwortet hier 404 — die Ankündigung kommt trotzdem, nur ohne „Zuletzt".
    quelle({});
    const { deps, gesendet } = sammler();
    const erster = await bot.pushHandballBot(new Date(), deps);
    expect(erster.messages).toBe(1);
    expect(erster.recipients).toBe(2);
    // Anwurf in 30 Minuten: kurz vor Mitternacht ist das schon der nächste Tag, sonst heute.
    expect(gesendet[0].text).toMatch(/spielt (heute|am \S+, \d\d\.\d\d\.) um/);
    expect(gesendet[0].text).toContain('gegen HV Erftstadt (Heimspiel)');
    expect(gesendet[0].text).toContain('📍 Sporthalle Heimerzheim');
    const zweiter = await bot.pushHandballBot(new Date(), deps);
    expect(zweiter.messages).toBe(0);
  });

  it('grüßt am Spieltagsmorgen — nach acht Uhr, einmal je Chat, nicht ohne Ankündigungswunsch', async () => {
    abonniere('1'); abonniere('2');
    dbRef.update(schemaRef.handball_bot_subscriber).set({ lead: 'aus' }).where(eq(schemaRef.handball_bot_subscriber.chat_id, '2')).run();
    // Anwurf 17:00 Uhr Ortszeit (Sommerzeit: 15:00 UTC).
    legeSpiel({ starts_at: '2026-10-10T15:00:00.000Z' });
    const { deps, gesendet } = sammler();

    // 7:30 Uhr: zu früh.
    await bot.pushHandballBot(new Date('2026-10-10T05:30:00.000Z'), deps);
    expect(gesendet).toHaveLength(0);

    // 9:00 Uhr: der Gruß an den Chat, der Ankündigungen will — nicht an den mit „keine".
    const r = await bot.pushHandballBot(new Date('2026-10-10T07:00:00.000Z'), deps);
    expect(r.recipients).toBe(1);
    expect(gesendet).toHaveLength(1);
    expect(gesendet[0].chatId).toBe('1');
    expect(gesendet[0].text).toContain('☀️ <b>Spieltag!</b> HSG Wölfe Voreifel spielt heute um 17:00 Uhr');
    expect(gesendet[0].text).toContain('gegen HV Erftstadt (Heimspiel)');
    expect(gesendet[0].text).toContain('📍 Sporthalle Heimerzheim');

    // Noch einmal im nächsten Takt: nichts.
    await bot.pushHandballBot(new Date('2026-10-10T07:15:00.000Z'), deps);
    expect(gesendet).toHaveLength(1);

    // Kurz vor dem Anwurf (16:00 Uhr) übernimmt die Ankündigung, kein zweiter Gruß.
    await bot.pushHandballBot(new Date('2026-10-10T14:05:00.000Z'), deps);
    expect(gesendet.filter(g => g.text.includes('Spieltag!'))).toHaveLength(1);
  });

  it('lässt den Gruß aus, wenn die Ankündigung ohnehin binnen zwei Stunden kommt', async () => {
    abonniere('drei');
    dbRef.update(schemaRef.handball_bot_subscriber).set({ lead: '3h' }).where(eq(schemaRef.handball_bot_subscriber.chat_id, 'drei')).run();
    // Anwurf 13:00 Uhr Ortszeit, Ankündigung „3h" um 10:00 — um 9:00 Uhr kein Gruß mehr.
    legeSpiel({ starts_at: '2026-10-10T11:00:00.000Z' });
    const { deps, gesendet } = sammler();
    await bot.pushHandballBot(new Date('2026-10-10T07:00:00.000Z'), deps);
    expect(gesendet.filter(g => g.text.includes('Spieltag!'))).toHaveLength(0);
  });

  it('grüßt nicht, wenn die Ankündigung des Spiels schon raus ist oder der Anwurf zu nah liegt', () => {
    const spiel = (startsAt: string) => ({ starts_at: startsAt, is_home: true, away_name: 'Gegner', home_name: 'HSG', venue_name: null, venue_address: null, away_id: '1', home_id: '2' }) as never;
    // Anwurf 12:00 Uhr, jetzt 9:00 Uhr: nur drei Stunden — zu knapp für einen Gruß.
    expect(bot.spieltagsGrussFaellig(spiel('2026-10-10T10:00:00.000Z'), new Date('2026-10-10T07:00:00.000Z'))).toBe(false);
    // Anderer Kalendertag.
    expect(bot.spieltagsGrussFaellig(spiel('2026-10-11T15:00:00.000Z'), new Date('2026-10-10T07:00:00.000Z'))).toBe(false);
    expect(bot.spieltagsGrussFaellig(spiel('2026-10-10T15:00:00.000Z'), new Date('2026-10-10T07:00:00.000Z'))).toBe(true);
  });

  it('schickt die Aufstellung, sobald sie da ist, und nicht vorher', async () => {
    abonniere();
    legeSpiel({ starts_at: new Date(Date.now() + 2 * 60 * 1000).toISOString() });
    const { deps, gesendet } = sammler();

    // Noch leer: kein Text, kein Merker — beim nächsten Takt wird erneut gesehen.
    aufstellungsQuelle([]);
    const leer = await bot.pushHandballBot(new Date(), deps);
    expect(leer.fetches).toBe(1);
    expect(gesendet.filter(g => g.text.includes('Aufstellung'))).toHaveLength(0);

    legeKader();
    // Nr. 22 trägt heute Schüssler (im Kader unter 23) — die ID entscheidet, nicht die Nummer.
    aufstellungsQuelle([
      { player: { id: 'p-unbekannt' }, number: 1, is_goalkeeper: true, goals: 0 },
      { player: { id: 'p-lieck' }, number: 25, is_captain: true, goals: 0 },
      { player: { id: 'p-schuessler' }, number: 22, goals: 0 },
    ]);
    const voll = await bot.pushHandballBot(new Date(), deps);
    expect(voll.messages).toBeGreaterThanOrEqual(1);
    const text = gesendet.find(g => g.text.includes('Aufstellung'))!.text;
    expect(text).toContain('Nr. 1 (TW)');
    expect(text).toContain('22 Finn Schüssler');
    expect(text).toContain('25 Eskil Lieck (C)');
    expect(text).not.toContain('Raab');
    expect(text).toContain('3 Spieler, 1 an der Bank');
    expect(text).not.toContain('Namen fehlen');
  });

  it('meldet den Endstand mit Torschützen nach Nummer', async () => {
    abonniere();
    legeSpiel({ starts_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(), status: 'finished', score_home: 30, score_away: 22 });
    legeKader();
    aufstellungsQuelle([
      { player: { id: 'p-lieck' }, number: 25, goals: 7, seven_meter_goals: 1 },
      { player: { id: 'p-fremd' }, number: 22, goals: 2 },
      { player: { id: 'p-raab' }, number: 1, is_goalkeeper: true, goals: 0 },
    ]);
    const { deps, gesendet } = sammler();
    await bot.pushHandballBot(new Date(), deps);
    const text = gesendet.find(g => g.text.includes('🏁'))!.text;
    expect(text).toContain('HSG Wölfe Voreifel gewinnt 30:22');
    expect(text).toContain('Tore: Eskil Lieck 7 (1× 7m), Nr. 22 2');
    expect(text).toContain('handball.net/match/m1');
  });

  it('schickt den Endstand als Karte mit dem Text als Unterschrift, wenn ein Bild-Weg da ist', async () => {
    abonniere();
    legeSpiel({ starts_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(), status: 'finished', score_home: 30, score_away: 22, halftime_home: 15, halftime_away: 11 });
    legeKader();
    aufstellungsQuelle([{ player: { id: 'p-lieck' }, number: 25, goals: 7 }]);
    const fotos: Array<{ png: Buffer; caption: string; filename?: string }> = [];
    const { deps, gesendet } = sammler();
    const mitBild = { ...deps, sendPhoto: vi.fn(async (_c: string, png: Buffer, caption: string, filename?: string) => { fotos.push({ png, caption, filename }); }) };
    await bot.pushHandballBot(new Date(), mitBild);
    expect(fotos).toHaveLength(1);
    expect(fotos[0].filename).toBe('endstand.png');
    expect(fotos[0].caption).toContain('HSG Wölfe Voreifel gewinnt 30:22');
    expect(fotos[0].caption).toContain('Tore: Eskil Lieck 7');
    expect(fotos[0].png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // Kein zweiter Text, wenn die Unterschrift passt.
    expect(gesendet).toHaveLength(0);

    // Bricht das Bild, kommt der Text.
    dbRef.delete(schemaRef.handball_bot_sent).run();
    const kaputt = { ...deps, sendPhoto: vi.fn(async () => { throw new Error('zu groß'); }) };
    await bot.pushHandballBot(new Date(), kaputt);
    expect(gesendet[0].text).toContain('🏁');
  });

  it('liefert alte Endstände nicht nach', async () => {
    abonniere();
    legeSpiel({ starts_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), status: 'finished', score_home: 30, score_away: 22 });
    const { deps, gesendet } = sammler();
    const r = await bot.pushHandballBot(new Date(), deps);
    expect(r.messages).toBe(0);
    expect(gesendet).toHaveLength(0);
    // … und merkt sich das, damit es beim nächsten Takt nicht doch kommt.
    expect(dbRef.select().from(schemaRef.handball_bot_sent).all().some(s => s.id.endsWith(':result'))).toBe(true);
  });

  it('trägt aus, wer den Bot blockiert hat', async () => {
    abonniere('blockiert'); abonniere('treu');
    legeSpiel({ starts_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
    const deps = {
      send: vi.fn(async (chatId: string) => {
        if (chatId === 'blockiert') throw new TelegramApiError('sendMessage', 403, 'bot was blocked by the user');
      }),
    };
    const r = await bot.pushHandballBot(new Date(), deps);
    expect(r.recipients).toBe(1);
    expect(bot.listSubscribers().map(s => s.chatId)).toEqual(['treu']);
  });
});

describe('Zweite Runde: Halbzeit, Bericht, Verlegung, Route, Steckbrief', () => {
  it('hängt an die Ankündigung den Routen-Knopf und den Gegner-Steckbrief', async () => {
    abonniere();
    legeTabelle();
    // Hinspiel, schon gespielt, gegen denselben Gegner.
    legeSpiel({ match_id: 'm0', starts_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), status: 'finished', score_home: 30, score_away: 22, home_id: '96300', home_name: 'HV Erftstadt', away_id: TEAM, away_name: 'HSG Wölfe Voreifel' });
    legeSpiel({ starts_at: new Date(Date.now() + 50 * 60 * 1000).toISOString(), venue_lat: 50.6464842, venue_lon: 6.831915 });
    const f = quelle({ '/matches?team_id=96300': { data: [
      { id: 9001, date: '2026-09-19T15:00:00+00:00', status: { id: 1, name: 'Finalizado', is_finished: true }, phase: { season_id: 2627 }, local: { id: 96300, name: 'HV ERFTSTADT' }, visitor: { id: 1, name: 'TV X' }, result: { local: 25, visitor: 20 } },
      { id: 9002, date: '2026-09-12T15:00:00+00:00', status: { id: 1, name: 'Finalizado', is_finished: true }, phase: { season_id: 2627 }, local: { id: 2, name: 'TV Y' }, visitor: { id: 96300, name: 'HV ERFTSTADT' }, result: { local: 28, visitor: 21 } },
    ] } });
    const { deps, gesendet } = sammler();
    await bot.pushHandballBot(new Date(), deps);
    expect(f.mock.calls.filter(c => String(c[0]).includes('team_id=96300'))).toHaveLength(1);
    const text = gesendet[0].text;
    expect(text).toContain('Gegner: 2. Platz · 2-0-1 · 80:70 Tore · 4 Pkt');
    expect(text).toContain('Zuletzt: ✅ 25:20 gegen TV X · ❌ 21:28 bei TV Y');
    expect(text).toContain('Hinspiel: 22:30 (A)');
    const kb = gesendet[0].keyboard as { inline_keyboard: Array<Array<{ text: string; url: string }>> };
    expect(kb.inline_keyboard[0][0].url).toContain('google.com/maps/dir/?api=1&destination=50.6464842%2C6.831915');
    expect(kb.inline_keyboard[0][1].url).toContain('openstreetmap.org');
    // Ohne Koordinaten: die Anschrift als Ziel.
    const { handballOverview } = await import('../lib/handballTeam');
    const m = { ...handballOverview().teams[0].matches.find(x => x.match_id === 'm1')!, venue_lat: null, venue_lon: null };
    expect(bot.routenTastatur(m)!.inline_keyboard[0]).toHaveLength(1);
    expect(bot.routenTastatur({ ...m, venue_address: null })).toBeNull();
  });

  it('meldet den Halbzeitstand, sobald die zweite Halbzeit läuft — einmal', async () => {
    abonniere();
    legeSpiel({ starts_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(), status: 'live' });
    const events = [{ block: ' 1. Halbzeit', event_type: { name: 'Tor', is_goal: true }, score: { local: 13, visitor: 12 } }];
    const f = quelle({ '/events': { data: events } });
    const { deps, gesendet } = sammler();
    await bot.pushHandballBot(new Date(), deps);
    expect(gesendet.filter(g => g.text.includes('Halbzeit'))).toHaveLength(0);
    events.push({ block: ' 2. Halbzeit', event_type: { name: 'Tor', is_goal: true }, score: { local: 14, visitor: 12 } });
    await bot.pushHandballBot(new Date(), deps);
    const text = gesendet.find(g => g.text.includes('Halbzeit'))!.text;
    expect(text).toContain('Halbzeit: HSG Wölfe Voreifel 13:12');
    expect(text).toContain('vorn');
    await bot.pushHandballBot(new Date(), deps);
    expect(gesendet.filter(g => g.text.includes('Halbzeit'))).toHaveLength(1);
    expect(f.mock.calls.filter(c => String(c[0]).includes('/events'))).toHaveLength(2);
    expect(dbRef.select().from(schemaRef.handball_team_match).all()[0]).toMatchObject({ halftime_home: 13, halftime_away: 12 });
  });

  it('schickt nach dem Endstand den Spielbericht, hebt ihn auf, und /bericht liest ihn ohne Abruf', async () => {
    abonniere();
    legeSpiel({ starts_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(), status: 'finished', score_home: 30, score_away: 22, report_url: 'https://handball360.isquad.de/pdf?id=1' });
    const f = quelle({
      '/lineups': { data: { local: { team: { id: 96254, name: 'HSG WÖLFE VOREIFEL' }, players: [{ player: { id: 'p-x' }, number: 9, goals: 3 }], staff: [] }, visitor: { team: { id: 96300, name: 'HV ERFTSTADT' }, players: [], staff: [] } } },
      '/additional-info': { data: [{ chronicle: '<h1>Spielbericht</h1><h2>Erste Halbzeit</h2><p>Früh in Führung &amp; nie abgegeben.</p>' }] },
    });
    const { deps, gesendet } = sammler();
    await bot.pushHandballBot(new Date(), deps);
    expect(gesendet.map(g => g.text.slice(0, 2))).toEqual(['🏁', '📰']);
    expect(gesendet[1].text).toContain('<b>Spielbericht: HSG Wölfe Voreifel 30:22 gegen HV Erftstadt</b>');
    expect(gesendet[1].text).toContain('<b>Erste Halbzeit</b>');
    expect(gesendet[1].text).toContain('Früh in Führung &amp; nie abgegeben.');
    expect(gesendet[1].text).toContain('Spielberichtsbogen (PDF)');
    // Die Aufstellung ist aufgehoben.
    expect(dbRef.select().from(schemaRef.handball_match_player).all()).toHaveLength(1);
    const aufrufe = f.mock.calls.length;
    await bot.handleHandballUpdate(update('/bericht'), deps);
    expect(gesendet[2].text).toContain('Erste Halbzeit');
    expect(f.mock.calls.length).toBe(aufrufe);
    // Ein zweiter Takt schickt nichts erneut.
    await bot.pushHandballBot(new Date(), deps);
    expect(gesendet).toHaveLength(3);
  });

  it('glättet im Bericht die Titelschreibung der Quelle mit den Namen aus der Datenbank', () => {
    const team = { team_id: TEAM, name: 'HSG Wölfe Voreifel', label: 'B-Jugend', championship_name: 'B-Jugend', next_match: null, last_match: null, matches: [], standings: [] };
    const m = {
      match_id: 'm1', season_id: 2627, starts_at: new Date().toISOString(), status: 'finished', status_name: '', round: 3, competition_name: 'Kreisoberliga mB',
      home_id: '96301', home_name: 'TV Palmersheim II', away_id: TEAM, away_name: 'HSG Wölfe Voreifel', is_home: false, score_home: 22, score_away: 30, won: true, rated: false,
      halftime_home: null, halftime_away: null, venue_name: 'Peter-Weber-Halle Kuchenheim', venue_address: null, venue_lat: null, venue_lon: null, report_url: null,
      report_text: 'Am 26. September trafen sich in der Peter-weber-halle Kuchenheim die Mannschaften von Tv Palmersheim Ii und Hsg Wölfe Voreifel im Rahmen der B-jugend - Kreisoberliga Mb.', events: null, url: 'u',
    };
    const t = bot.textBericht(team, m);
    expect(t).toContain('in der Peter-Weber-Halle Kuchenheim die Mannschaften von TV Palmersheim II und HSG Wölfe Voreifel im Rahmen der B-Jugend - Kreisoberliga mB.');
  });

  it('/bericht holt einen fehlenden Bericht einmal selbst und hebt ihn auf; ohne Bericht der Bogen', async () => {
    abonniere();
    legeSpiel({ starts_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), status: 'finished', score_home: 30, score_away: 22, report_url: 'https://handball360.isquad.de/pdf?id=1' });
    const f = quelle({ '/additional-info': { data: [{ chronicle: null }] } });
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/bericht'), deps);
    expect(gesendet[0].text).toContain('noch keinen Spielbericht');
    expect(gesendet[0].text).toContain('Spielberichtsbogen (PDF)');
    expect(f.mock.calls.filter(c => String(c[0]).includes('/additional-info'))).toHaveLength(1);

    quelle({ '/additional-info': { data: [{ chronicle: '<h2>Erste Halbzeit</h2><p>Los.</p>' }] } });
    await bot.handleHandballUpdate(update('/bericht'), deps);
    expect(gesendet[1].text).toContain('<b>Erste Halbzeit</b>');
    // Danach steht er in der Datenbank — der dritte Aufruf holt nichts mehr.
    const g = quelle({});
    await bot.handleHandballUpdate(update('/bericht'), deps);
    expect(gesendet[2].text).toContain('<b>Erste Halbzeit</b>');
    expect(g.mock.calls.filter(c => String(c[0]).includes('/additional-info'))).toHaveLength(0);
  });

  it('meldet Verlegung, Verschiebung und Absage — alte Zeilen nur gemerkt', async () => {
    abonniere();
    const alt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const neu = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString();
    legeSpiel({ starts_at: neu });
    legeSpiel({ match_id: 'm2', starts_at: alt, status: 'postponed' });
    legeSpiel({ match_id: 'm3', starts_at: alt, status: 'cancelled' });
    const now = new Date().toISOString();
    dbRef.insert(schemaRef.handball_match_change).values([
      { team_id: TEAM, match_id: 'm1', kind: 'rescheduled', old_starts_at: alt, new_starts_at: neu, detected_at: now },
      { team_id: TEAM, match_id: 'm2', kind: 'postponed', old_starts_at: alt, new_starts_at: alt, detected_at: now },
      { team_id: TEAM, match_id: 'm3', kind: 'cancelled', old_starts_at: alt, new_starts_at: alt, detected_at: now },
      { team_id: TEAM, match_id: 'm1', kind: 'rescheduled', old_starts_at: alt, new_starts_at: neu, detected_at: '2020-01-01T00:00:00.000Z' },
    ]).run();
    const { deps, gesendet } = sammler();
    const r = await bot.pushHandballBot(new Date(), deps);
    expect(r.messages).toBe(3);
    expect(gesendet[0].text).toContain('Spiel verlegt');
    expect(gesendet[0].text).toContain('ursprünglich');
    expect(gesendet[0].keyboard).not.toBeNull();
    expect(gesendet[1].text).toContain('Spiel verschoben');
    expect(gesendet[1].text).toContain('noch nicht fest');
    expect(gesendet[2].text).toContain('Spiel abgesetzt');
    // Nichts zweimal, und die alte Zeile ist gemerkt.
    await bot.pushHandballBot(new Date(), deps);
    expect(gesendet).toHaveLength(3);
    expect(dbRef.select().from(schemaRef.handball_bot_sent).all().filter(s => s.id.includes(':change:'))).toHaveLength(4);
  });

  it('/spieler listet Torschützen und kennt die Bilanz eines Spielers', async () => {
    abonniere();
    legeKader();
    legeSpiel({ status: 'finished' });
    const now = new Date().toISOString();
    dbRef.insert(schemaRef.handball_match_player).values([
      { id: `${TEAM}:m1:p-lieck`, team_id: TEAM, match_id: 'm1', player_id: 'p-lieck', number: 25, is_goalkeeper: false, goals: 7, seven_meter_goals: 1, seven_meter_attempts: 2, two_minutes: 1, updated_at: now },
      { id: `${TEAM}:m1:p-raab`, team_id: TEAM, match_id: 'm1', player_id: 'p-raab', number: 21, is_goalkeeper: false, goals: 2, seven_meter_goals: 0, seven_meter_attempts: 0, two_minutes: 0, updated_at: now },
    ]).run();
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/spieler'), deps);
    expect(gesendet[0].text).toContain('1. Eskil Lieck — 7 (1 Sp., 7,0/Spiel)');
    expect(gesendet[0].text).toContain('2. Jan Raab — 2 (1 Sp., 2,0/Spiel)');
    await bot.handleHandballUpdate(update('/spieler lieck'), deps);
    expect(gesendet[1].text).toContain('<b>Eskil Lieck</b> (Nr. 25)');
    expect(gesendet[1].text).toContain('7 Tore in 1 Spiel · 1/2 Siebenmeter · 1× 2 min');
    await bot.handleHandballUpdate(update('/spieler Meier'), deps);
    expect(gesendet[2].text).toContain('keinen Spieler');
    // Ohne Namen ein Knopf je Spieler mit Einsatz — nach Nummer, mit der Spieler-ID im Rückruf.
    const knoepfe = (gesendet[0].keyboard as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard.flat();
    expect(knoepfe.map(k => `${k.text}=${k.callback_data}`)).toEqual(['21 Raab=cmd:spieler:p-raab', '25 Lieck=cmd:spieler:p-lieck']);
    // Der Knopf holt die Bilanz über die ID.
    await bot.handleHandballUpdate({ update_id: 991, callback_query: { id: 'cb1', from: { id: 4711, first_name: 'Kumpel' }, message: { message_id: 5, chat: { id: 4711, type: 'private' } }, data: 'cmd:spieler:p-raab' } } as never, deps);
    expect(gesendet[gesendet.length - 1].text).toContain('<b>Jan Raab</b> (Nr. 21)');
  });

  it('/spieler Name kommt ab zwei Spielen als Bild, /torjaeger als Balken, /rekorde als Text', async () => {
    abonniere();
    legeKader();
    const alt = (tage: number) => new Date(Date.now() - tage * 24 * 60 * 60 * 1000).toISOString();
    legeSpiel({ match_id: 'm1', status: 'finished', score_home: 30, score_away: 22, halftime_home: 16, halftime_away: 10, starts_at: alt(14) });
    legeSpiel({ match_id: 'm2', status: 'finished', score_home: 27, score_away: 21, starts_at: alt(7), home_id: '96300', home_name: 'HV Erftstadt', away_id: TEAM, away_name: 'HSG Wölfe Voreifel' });
    const now = new Date().toISOString();
    dbRef.insert(schemaRef.handball_match_player).values([
      { id: `${TEAM}:m1:p-lieck`, team_id: TEAM, match_id: 'm1', player_id: 'p-lieck', number: 25, is_goalkeeper: false, goals: 7, seven_meter_goals: 3, seven_meter_attempts: 3, two_minutes: 1, updated_at: now },
      { id: `${TEAM}:m2:p-lieck`, team_id: TEAM, match_id: 'm2', player_id: 'p-lieck', number: 25, is_goalkeeper: false, goals: 12, seven_meter_goals: 0, seven_meter_attempts: 0, two_minutes: 0, updated_at: now },
      { id: `${TEAM}:m1:p-raab`, team_id: TEAM, match_id: 'm1', player_id: 'p-raab', number: 21, is_goalkeeper: false, goals: 2, seven_meter_goals: 0, seven_meter_attempts: 0, two_minutes: 0, updated_at: now },
    ]).run();
    const fotos: Array<{ caption: string; filename?: string }> = [];
    const { deps, gesendet } = sammler();
    const mitBild = { ...deps, sendPhoto: vi.fn(async (_c: string, _p: Buffer, caption: string, filename?: string) => { fotos.push({ caption, filename }); }) };
    await bot.handleHandballUpdate(update('/spieler lieck'), mitBild);
    expect(fotos[0].filename).toBe('spieler.png');
    expect(fotos[0].caption).toContain('<b>Eskil Lieck</b> (Nr. 25)');
    expect(fotos[0].caption).toContain('Tore je Spiel: 7 · 12');
    // Ein Spieler mit nur einem Spiel bleibt Text.
    await bot.handleHandballUpdate(update('/spieler raab'), mitBild);
    expect(fotos).toHaveLength(1);
    expect(gesendet[0].text).toContain('<b>Jan Raab</b>');
    await bot.handleHandballUpdate(update('/torjaeger'), mitBild);
    expect(fotos[1].filename).toBe('torjaeger.png');
    expect(fotos[1].caption).toContain('1. Eskil Lieck — 19 (2 Sp., 9,5/Spiel)');
    await bot.handleHandballUpdate(update('/rekorde'), mitBild);
    const r = gesendet[1].text;
    expect(r).toContain('Höchster Sieg: 30:22 gegen HV Erftstadt');
    expect(r).toContain('Höchste Niederlage: 21:27 bei HV Erftstadt');
    expect(r).toContain('Meiste eigene Tore: 30:22 gegen HV Erftstadt');
    expect(r).toContain('Wenigste Gegentore: 30:22 gegen HV Erftstadt');
    expect(r).toContain('Torreichstes Spiel: 30:22 gegen HV Erftstadt');
    expect(r).toContain('Beste erste Halbzeit: 16:10 gegen HV Erftstadt');
    expect(r).toContain('Meiste Tore eines Spielers: 12 — Eskil Lieck bei HV Erftstadt');
    expect(r).toContain('Meiste Siebenmeter-Tore in einem Spiel: 3 — Eskil Lieck');
    expect(r).not.toContain('Längste Siegesserie');
  });
});

describe('Gruppen', () => {
  it('abonniert eine Gruppe unter ihrem Titel, versteht @bot-Befehle und schweigt bei Freitext', async () => {
    legeSpiel();
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(gruppenUpdate('/start@woelfe_bot'), deps);
    expect(bot.listSubscribers()).toMatchObject([{ chatId: '-100123', name: 'Gruppe: Eltern B-Jugend', lead: '1h', mode: 'all' }]);
    expect(gesendet[0].text).toContain('Willkommen');
    await bot.handleHandballUpdate(gruppenUpdate('/spiele@woelfe_bot'), deps);
    expect(gesendet[1].text).toContain('nächste Spiele');
    await bot.handleHandballUpdate(gruppenUpdate('hallo zusammen'), deps);
    expect(gesendet).toHaveLength(2);
  });

  it('trägt eine Gruppe aus, wenn der Bot entfernt wird oder der Chat nicht mehr existiert', async () => {
    abonniere('-100123'); abonniere('-100999'); abonniere('treu');
    const { deps } = sammler();
    await bot.handleHandballUpdate({ update_id: 77, my_chat_member: { chat: { id: -100123, type: 'supergroup', title: 'X' }, new_chat_member: { status: 'left' } } }, deps);
    expect(bot.listSubscribers().map(s => s.chatId)).toEqual(['-100999', 'treu']);
    legeSpiel({ starts_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
    const kaputt = {
      send: vi.fn(async (chatId: string) => {
        if (chatId === '-100999') throw new TelegramApiError('sendMessage', 400, 'Bad Request: chat not found');
      }),
    };
    await bot.pushHandballBot(new Date(), kaputt);
    expect(bot.listSubscribers().map(s => s.chatId)).toEqual(['treu']);
  });
});

describe('Dritte Runde: Erinnerung, Modus, Knöpfe, Saison, Kalender, Live, Betreiber', () => {
  it('kündigt je Chat zu seiner Zeit an — 1h, 3h, Vorabend, aus — und Endstände gehen an alle', async () => {
    abonniere('eins'); abonniere('drei'); abonniere('abend'); abonniere('aus'); abonniere('ergebnisse');
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/erinnerung 3h', 'drei' as never), deps);
    await bot.handleHandballUpdate(update('/erinnerung abend', 'abend' as never), deps);
    await bot.handleHandballUpdate(update('/erinnerung aus', 'aus' as never), deps);
    await bot.handleHandballUpdate(update('/modus ergebnisse', 'ergebnisse' as never), deps);
    expect(gesendet.map(g => g.text)).toEqual(expect.arrayContaining([expect.stringContaining('drei Stunden vorher'), expect.stringContaining('keine Ankündigung mehr'), expect.stringContaining('nur noch Endstand')]));
    gesendet.length = 0;
    // Spiel in zwei Stunden: „3h" ist fällig — und „abend", weil der Vorabend schon vorbei ist.
    legeSpiel({ starts_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() });
    quelle({});
    await bot.pushHandballBot(new Date(), deps);
    expect(gesendet.map(g => g.chatId).sort()).toEqual(['abend', 'drei']);
    expect(gesendet[0].keyboard).toBeTruthy();
    // Gleicher Takt noch einmal: nichts doppelt.
    await bot.pushHandballBot(new Date(), deps);
    expect(gesendet).toHaveLength(2);
    // Fünfzig Minuten vorher: jetzt auch „1h" — „aus" und „nur Ergebnisse" nie.
    dbRef.update(schemaRef.handball_team_match).set({ starts_at: new Date(Date.now() + 50 * 60 * 1000).toISOString() }).run();
    await bot.pushHandballBot(new Date(), deps);
    expect(gesendet.map(g => g.chatId).sort()).toEqual(['abend', 'drei', 'eins']);
    // Vorabend: Anwurf morgen 14:45 Berlin → fällig ab heute 19:00 Berlin.
    const morgen = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const ab = bot.ankuendigungFaelligAb(morgen, 'abend')!;
    expect(new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(new Date(ab))).toBe('19:00');
    expect(ab).toBeLessThan(Date.parse(morgen));
    expect(bot.ankuendigungFaelligAb(morgen, 'aus')).toBeNull();
    expect(bot.ankuendigungFaelligAb(morgen, '3h')).toBe(Date.parse(morgen) - 3 * 60 * 60 * 1000);
  });

  it('„nur Ergebnisse" bekommt Aufstellung und Halbzeit nicht, den Endstand schon — und der Sieg eine Reaktion', async () => {
    abonniere('alles'); abonniere('nur');
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/modus ergebnisse', 'nur' as never), deps);
    gesendet.length = 0;
    legeSpiel({ starts_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(), status: 'live' });
    quelle({
      '/events': { data: [{ block: ' 1. Halbzeit', event_type: { name: 'Tor' }, score: { local: 13, visitor: 12 } }, { block: ' 2. Halbzeit', event_type: { name: 'Tor' }, score: { local: 14, visitor: 12 } }] },
    });
    await bot.pushHandballBot(new Date(), deps);
    expect(gesendet.filter(g => g.text.includes('Halbzeit')).map(g => g.chatId)).toEqual(['alles']);
    gesendet.length = 0;
    dbRef.update(schemaRef.handball_team_match).set({ status: 'finished', score_home: 30, score_away: 22 }).run();
    const reaktionen: Array<{ chatId: string; messageId: number; emoji: string }> = [];
    let id = 100;
    const mitId = {
      send: vi.fn(async (chatId: string, text: string, keyboard?: unknown) => { gesendet.push({ chatId, text, keyboard }); return ++id; }),
      react: vi.fn(async (chatId: string, messageId: number, emoji: string) => { reaktionen.push({ chatId, messageId, emoji }); }),
    };
    quelle({ '/lineups': { data: { local: { team: { id: 96254, name: 'X' }, players: [], staff: [] }, visitor: { team: { id: 96300, name: 'Y' }, players: [], staff: [] } } } });
    await bot.pushHandballBot(new Date(), mitId);
    const endstaende = gesendet.filter(g => g.text.includes('🏁'));
    expect(endstaende.map(g => g.chatId).sort()).toEqual(['alles', 'nur']);
    expect(endstaende[0].text).toContain('Halbzeit 13:12');
    expect(reaktionen).toHaveLength(2);
    expect(reaktionen[0]).toMatchObject({ emoji: '🏆', messageId: 101 });
    // Der Endstand trägt Knöpfe: Tabelle, Bericht, Spielseite.
    const kb = endstaende[0].keyboard as { inline_keyboard: Array<Array<{ text: string }>> };
    expect(kb.inline_keyboard.flat().map(b => b.text)).toEqual(expect.arrayContaining(['📊 Tabelle', '📰 Bericht', 'Spielseite']));
  });

  it('nennt im Endstand Spieler des Spiels, erstes Saisontor und die Tabellenbewegung', async () => {
    legeKader();
    const now = new Date().toISOString();
    // Vorher: Lieck hat schon getroffen, Raab noch nicht (ein Spiel ohne Tor).
    dbRef.insert(schemaRef.handball_match_player).values([
      { id: `${TEAM}:m0:p-lieck`, team_id: TEAM, match_id: 'm0', player_id: 'p-lieck', number: 25, is_goalkeeper: false, goals: 4, seven_meter_goals: 0, seven_meter_attempts: 0, two_minutes: 0, updated_at: now },
      { id: `${TEAM}:m0:p-raab`, team_id: TEAM, match_id: 'm0', player_id: 'p-raab', number: 21, is_goalkeeper: false, goals: 0, seven_meter_goals: 0, seven_meter_attempts: 0, two_minutes: 0, updated_at: now },
    ]).run();
    legeSpiel({ status: 'finished', score_home: 30, score_away: 22, halftime_home: 15, halftime_away: 11 });
    // Tabelle: vorher Platz 2, jetzt Platz 1.
    dbRef.insert(schemaRef.handball_standings).values({
      phase_id: 12800, season_id: 2627, competition_name: 'Kreisoberliga mB', fetched_at: now,
      payload: JSON.stringify([
        { round: 4, position: 1, teamId: TEAM, teamName: 'HSG Wölfe Voreifel', played: 4, won: 3, drawn: 0, lost: 1, goalsFor: 120, goalsAgainst: 100, goalsDiff: 20, points: 6 },
        { round: 4, position: 2, teamId: '96300', teamName: 'HV Erftstadt', played: 4, won: 2, drawn: 0, lost: 2, goalsFor: 100, goalsAgainst: 100, goalsDiff: 0, points: 4 },
      ]),
      previous_payload: JSON.stringify([
        { round: 3, position: 1, teamId: '96300', teamName: 'HV Erftstadt', played: 3, won: 2, drawn: 0, lost: 1, goalsFor: 80, goalsAgainst: 70, goalsDiff: 10, points: 4 },
        { round: 3, position: 2, teamId: TEAM, teamName: 'HSG Wölfe Voreifel', played: 3, won: 2, drawn: 0, lost: 1, goalsFor: 90, goalsAgainst: 78, goalsDiff: 12, points: 4 },
      ]),
      previous_fetched_at: now,
    }).run();
    const { handballOverview, playerStats } = await import('../lib/handballTeam');
    const team = handballOverview().teams[0];
    const m = team.matches.find(x => x.match_id === 'm1')!;
    const seite = { teamId: TEAM, teamName: 'HSG Wölfe Voreifel', staffCount: 0, players: [
      { playerId: 'p-lieck', number: 25, isGoalkeeper: false, isCaptain: false, goals: 7, sevenMeterGoals: 1, sevenMeterAttempts: 2, twoMinutes: 0 },
      { playerId: 'p-raab', number: 21, isGoalkeeper: false, isCaptain: false, goals: 2, sevenMeterGoals: 0, sevenMeterAttempts: 0, twoMinutes: 0 },
    ] };
    const text = bot.textEndstand(team, m, seite, undefined, { vorher: playerStats(TEAM, { excludeMatchId: 'm1' }), bewegung: bot.tabellenBewegung(team) });
    expect(text).toContain('⭐ Spieler des Spiels: Eskil Lieck mit 7 Toren, 1/2 Siebenmeter');
    expect(text).toContain('🎯 Erstes Saisontor: Jan Raab');
    expect(text).toContain('📊 Von Platz 2 auf 1 geklettert, Vorsprung 2 Punkte');
    expect(text).toContain('Halbzeit 15:11');
  });

  it('/saison rechnet die Bilanz aus dem Spielplan', async () => {
    abonniere();
    const alt = (tage: number) => new Date(Date.now() - tage * 24 * 60 * 60 * 1000).toISOString();
    legeSpiel({ match_id: 'a', status: 'finished', score_home: 30, score_away: 22, starts_at: alt(21) });
    legeSpiel({ match_id: 'b', status: 'finished', score_home: 20, score_away: 25, starts_at: alt(14), home_id: '96300', home_name: 'HV Erftstadt', away_id: TEAM, away_name: 'HSG Wölfe Voreifel' });
    legeSpiel({ match_id: 'c', status: 'finished', score_home: 28, score_away: 28, starts_at: alt(7) });
    legeTabelle();
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/saison'), deps);
    const t = gesendet[0].text;
    expect(t).toContain('3 Spiele: 2 Siege, 1 Unentschieden, 0 Niederlagen · 5:1 Punkte');
    expect(t).toContain('Tore 83:70');
    expect(t).toContain('Heim 1-1-0 (58:50) · Auswärts 1-0-0 (25:20)');
    expect(t).toContain('Höchster Sieg: 30:22 gegen HV Erftstadt');
    expect(t).toContain('Längste Siegesserie: 2 Spiele');
    expect(t).toContain('Tabelle: Platz 1 mit 6 Punkten');
    // Ohne Halbzeitstände keine Halbzeit-Zeile.
    expect(t).not.toContain('1. Halbzeit');
  });

  it('/saison nennt den Schnitt je Halbzeit und zeigt den Tabellenplatz-Verlauf als Bild', async () => {
    abonniere();
    const alt = (tage: number) => new Date(Date.now() - tage * 24 * 60 * 60 * 1000).toISOString();
    legeSpiel({ match_id: 'a', status: 'finished', score_home: 30, score_away: 22, halftime_home: 16, halftime_away: 10, starts_at: alt(21) });
    legeSpiel({ match_id: 'b', status: 'finished', score_home: 20, score_away: 25, halftime_home: 12, halftime_away: 11, starts_at: alt(14), home_id: '96300', home_name: 'HV Erftstadt', away_id: TEAM, away_name: 'HSG Wölfe Voreifel' });
    legeSpiel({ match_id: 'c', status: 'finished', score_home: 28, score_away: 28, starts_at: alt(7) });
    legeSpiel({ match_id: 'd', status: 'scheduled', starts_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() });
    const zeile = (round: number, position: number, teamId: string, points: number) => ({ round, position, teamId, teamName: teamId === TEAM ? 'HSG Wölfe Voreifel' : 'HV Erftstadt', played: round, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalsDiff: 0, points });
    dbRef.insert(schemaRef.handball_standings).values({
      phase_id: 12800, season_id: 2627, competition_name: 'Kreisoberliga mB', fetched_at: new Date().toISOString(),
      payload: JSON.stringify([zeile(3, 1, TEAM, 6), zeile(3, 2, '96300', 4)]),
      history_payload: JSON.stringify([zeile(1, 2, TEAM, 2), zeile(1, 1, '96300', 2), zeile(2, 1, TEAM, 4), zeile(2, 2, '96300', 2), zeile(3, 1, TEAM, 6), zeile(3, 2, '96300', 4)]),
    }).run();
    const fotos: Array<{ caption: string; filename?: string }> = [];
    const { deps, gesendet } = sammler();
    const mitBild = { ...deps, sendPhoto: vi.fn(async (_c: string, _p: Buffer, caption: string, filename?: string) => { fotos.push({ caption, filename }); }) };
    await bot.handleHandballUpdate(update('/saison'), mitBild);
    expect(fotos).toHaveLength(1);
    expect(fotos[0].filename).toBe('verlauf.png');
    // Halbzeit: eigene 16 und 11 (bei Erftstadt: away), Gegner 10 und 12 — zweite Halbzeit 14+14 : 12+8.
    expect(fotos[0].caption).toContain('1. Halbzeit Ø 13,5:11,0 · 2. Halbzeit Ø 14,0:10,0 (2 Spiele mit Halbzeitstand)');
    expect(fotos[0].caption).toContain('Schnitt 27,7 : 23,3');
    expect(gesendet).toHaveLength(0);
    // Der Verlauf aus der Historie: Platz 2, 1, 1.
    const teamMod = await import('../lib/handballTeam');
    const verlauf = teamMod.positionHistory(teamMod.handballOverview().teams[0].standings[0], TEAM);
    expect(verlauf.map(p => `${p.round}:${p.position}:${p.points}:${p.teams}`)).toEqual(['1:2:2:2', '2:1:4:2', '3:1:6:2']);
    // Mitten in der Saison (Spiel d steht noch aus): kein Album und keine Karte
    // von selbst — nur der Verlauf, der Knopf heißt „Zwischenbilanz". Bis zum
    // 27.09.2026 kam hier eine Abschlusskarte mit „Meister" im Album mit.
    const alben: Array<Array<{ filename: string; caption?: string }>> = [];
    const knoepfe: string[] = [];
    const mitAlbum = {
      ...mitBild,
      sendPhoto: vi.fn(async (_c: string, _p: Buffer, caption: string, filename?: string, keyboard?: { inline_keyboard: Array<Array<{ text: string }>> } | null) => {
        fotos.push({ caption, filename });
        for (const reihe of keyboard?.inline_keyboard ?? []) for (const k of reihe) knoepfe.push(k.text);
      }),
      sendMediaGroup: vi.fn(async (_c: string, photos: Array<{ png: Buffer; filename: string; caption?: string }>) => { alben.push(photos); }),
    };
    fotos.length = 0;
    await bot.handleHandballUpdate(update('/saison'), mitAlbum);
    expect(alben).toHaveLength(0);
    expect(fotos.map(f => f.filename)).toEqual(['verlauf.png']);
    expect(knoepfe).toContain('📊 Zwischenbilanz');
    expect(gesendet).toHaveLength(0);

    // Die Karte mitten in der Saison ist eine Zwischenbilanz — Platz 1 heißt
    // Tabellenführer, nicht Meister.
    const zwischen = bot.bildSaison(teamMod.handballOverview().teams[0])!;
    expect(zwischen.toUpperCase()).toContain('ZWISCHENBILANZ');
    expect(zwischen).toContain('TABELLENFÜHRER');
    expect(zwischen).not.toContain('MEISTER');
    expect(zwischen).not.toContain('ENDPLATZ');

    // Nach dem letzten Spieltag: Verlauf und Saisonkarte als zwei eigene Fotos,
    // weiterhin kein Album (verschiedene Seitenverhältnisse schneidet Telegram zu).
    dbRef.delete(schemaRef.handball_team_match).where(eq(schemaRef.handball_team_match.match_id, 'd')).run();
    fotos.length = 0;
    knoepfe.length = 0;
    await bot.handleHandballUpdate(update('/saison'), mitAlbum);
    expect(alben).toHaveLength(0);
    expect(fotos.map(f => f.filename)).toEqual(['verlauf.png', 'saison.png']);
    expect(knoepfe).toContain('🏅 Saisonkarte');
    const ende = bot.bildSaison(teamMod.handballOverview().teams[0])!;
    expect(ende.toUpperCase()).toContain('SAISONBILANZ');
    expect(ende).toContain('MEISTER');
  }, 30_000);

  it('/kalender liefert eine ICS-Datei mit allen Spielen, ohne die abgesetzten', async () => {
    abonniere();
    legeSpiel();
    legeSpiel({ match_id: 'm2', status: 'cancelled', starts_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() });
    const dateien: Array<{ filename: string; data: Buffer; caption: string }> = [];
    const { deps } = sammler();
    const mitDatei = { ...deps, sendDocument: vi.fn(async (_c: string, data: Buffer, filename: string, caption: string) => { dateien.push({ filename, data, caption }); }) };
    await bot.handleHandballUpdate(update('/kalender'), mitDatei);
    expect(dateien).toHaveLength(1);
    expect(dateien[0].filename).toMatch(/\.ics$/);
    const ics = dateien[0].data.toString('utf8');
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('UID:handball-m1@todoteck');
    expect(ics).not.toContain('handball-m2');
    expect(ics).toContain('SUMMARY:HSG Wölfe Voreifel – HV Erftstadt');
    expect(ics).toContain('LOCATION:Sporthalle Heimerzheim\\, Schulstrasse 1\\, 53913 Swisttal');
  });

  it('/live liest die Torfolge, wenn ein Spiel läuft, und nennt sonst die nächsten', async () => {
    abonniere();
    const { deps, gesendet } = sammler();
    legeSpiel({ starts_at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() });
    await bot.handleHandballUpdate(update('/live'), deps);
    expect(gesendet[0].text).toContain('Gerade läuft kein Spiel');
    dbRef.update(schemaRef.handball_team_match).set({ starts_at: new Date(Date.now() - 20 * 60 * 1000).toISOString() }).run();
    quelle({ '/events': { data: [{ minute: '19:30', block: ' 1. Halbzeit', event_type: { name: 'Tor' }, score: { local: 9, visitor: 8 } }] } });
    await bot.handleHandballUpdate(update('/live'), deps);
    expect(gesendet[1].text).toContain('HSG Wölfe Voreifel 9:8');
    expect(gesendet[1].text).toContain('19. Minute, 1. Halbzeit');
  });

  it('Knöpfe lösen Befehle aus — Callback wird quittiert', async () => {
    abonniere();
    legeTabelle();
    legeSpiel();
    const quittiert: string[] = [];
    const { deps, gesendet } = sammler();
    const mitCb = { ...deps, answerCallback: vi.fn(async (id: string) => { quittiert.push(id); }) };
    await bot.handleHandballUpdate({ update_id: 5, callback_query: { id: 'cb1', from: { id: 4711, first_name: 'Kumpel' }, data: 'cmd:tabelle', message: { message_id: 1, chat: { id: 4711, type: 'private' } } } }, mitCb);
    expect(quittiert).toEqual(['cb1']);
    expect(gesendet[0].text).toContain('<pre>');
    await bot.handleHandballUpdate({ update_id: 6, callback_query: { id: 'cb2', from: { id: 4711, first_name: 'Kumpel' }, data: 'cmd:erinnerung:3h', message: { message_id: 1, chat: { id: 4711, type: 'private' } } } }, mitCb);
    expect(gesendet[1].text).toContain('drei Stunden vorher');
    expect(bot.listSubscribers()[0].lead).toBe('3h');
    // Die Hilfe trägt die Knopfleiste.
    await bot.handleHandballUpdate(update('/hilfe'), deps);
    const kb = gesendet[2].keyboard as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    expect(kb.inline_keyboard.flat().map(b => b.callback_data)).toContain('cmd:saison');
  });

  it('/status, /rundruf und /feedback: der Betreiber aus der Konfiguration', async () => {
    trageTeamEin({ bot_admin_chat_id: '4711' });
    abonniere('4711'); abonniere('4712');
    legeSpiel({ status: 'finished', score_home: 30, score_away: 22, starts_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() });
    const { deps, gesendet } = sammler();
    // Fremder: Chat-ID statt Betriebsstand, kein Rundruf.
    await bot.handleHandballUpdate(update('/status', 4712), deps);
    expect(gesendet[0].text).toContain('<code>4712</code>');
    await bot.handleHandballUpdate(update('/rundruf Hallo', 4712), deps);
    expect(gesendet[1].text).toContain('nur der Betreiber');
    // Feedback geht an den Betreiber und wird aufgehoben.
    await bot.handleHandballUpdate(update('/feedback Die Halbzeit kommt zu spät', 4712), deps);
    expect(gesendet[2]).toMatchObject({ chatId: '4711' });
    expect(gesendet[2].text).toContain('Die Halbzeit kommt zu spät');
    expect(gesendet[3]).toMatchObject({ chatId: '4712', text: 'Danke, ist angekommen.' });
    expect(dbRef.select().from(schemaRef.handball_bot_feedback).all()).toHaveLength(1);
    // Betreiber: Betriebsstand, Rundruf an alle.
    await bot.handleHandballUpdate(update('/status', 4711), deps);
    expect(gesendet[4].text).toContain('Betriebsstand');
    expect(gesendet[4].text).toContain('Abonnenten: 2');
    expect(gesendet[4].text).toContain('Nachzuholen: 1 Aufstellungen');
    expect(gesendet[4].text).toContain('Feedback: 1 Einträge, 1 offen');
    expect(gesendet[4].text).toContain('#1 ·');
    expect(gesendet[4].text).toContain('Zustellungen: 0 in 7 Tagen');
    // Die Browser-Abonnenten der Microsite (§7.3) stehen mit im Betriebsstand — sonst sieht man sie nur in der Cockpit-Karte.
    expect(gesendet[4].text).toContain('Microsite: keine Browser-Abonnenten');
    const jetzt = new Date().toISOString();
    dbRef.insert(schemaRef.handball_site_subscription).values([
      { team_id: TEAM, endpoint: 'https://push.example/a', p256dh: 'k', auth: 'a', lead: '1h', mode: 'all', failures: 0, created_at: jetzt, last_seen_at: jetzt },
      { team_id: TEAM, endpoint: 'https://push.example/b', p256dh: 'k', auth: 'a', lead: 'aus', mode: 'results', failures: 2, created_at: '2026-01-01T00:00:00.000Z', last_seen_at: jetzt },
    ]).run();
    await bot.handleHandballUpdate(update('/status', 4711), deps);
    expect(gesendet[gesendet.length - 1].text).toContain('Microsite: 2 Browser-Abonnenten, 1 neu in 7 Tagen, 1 nur Ergebnisse, 1 mit Zustellfehlern');
    // Der Knopf unter dem Betriebsstand markiert die Rückmeldung als erledigt.
    expect(JSON.stringify(gesendet[4].keyboard)).toContain('cmd:erledigt:1');
    await bot.handleHandballUpdate(update('/rundruf Ab jetzt gibt es den Halbzeitstand.', 4711), deps);
    const rundruf = gesendet.filter(g => g.text.includes('Info vom Betreiber'));
    expect(rundruf.map(g => g.chatId).sort()).toEqual(['4711', '4712']);
    expect(gesendet[gesendet.length - 1].text).toContain('Rundruf an 2 Chats');
    // Der Rundruf steht im Zustell-Protokoll, je Chat eine Zeile.
    const protokoll = dbRef.select().from(schemaRef.handball_bot_delivery).all();
    expect(protokoll.map(z => `${z.chat_id}:${z.kind}:${z.ok}`).sort()).toEqual(['4711:rundruf:1', '4712:rundruf:1']);
    await bot.handleHandballUpdate(update('/erledigt 1', 4711), deps);
    expect(gesendet[gesendet.length - 1].text).toContain('Rückmeldung #1 erledigt — keine mehr offen');
    expect(dbRef.select().from(schemaRef.handball_bot_feedback).all()[0].done_at).not.toBeNull();
    await bot.handleHandballUpdate(update('/status', 4711), deps);
    expect(gesendet[gesendet.length - 1].text).toContain('Feedback: 1 Einträge, 0 offen');
    expect(gesendet[gesendet.length - 1].keyboard).toBeNull();
  });

  it('ein gescheiterter Chat steht im Betriebsstand mit Grund', async () => {
    trageTeamEin({ bot_admin_chat_id: '4711' });
    abonniere('4711'); abonniere('4712');
    const { deps, gesendet } = sammler();
    deps.send.mockImplementation(async (chatId: string, text: string, keyboard?: unknown) => {
      if (chatId === '4712' && text.includes('Info vom Betreiber')) throw new TelegramApiError('sendMessage', 429, 'Too Many Requests: retry after 3', 3);
      gesendet.push({ chatId, text, keyboard });
    });
    await bot.handleHandballUpdate(update('/rundruf Test', 4711), deps);
    await bot.handleHandballUpdate(update('/status', 4711), deps);
    const status = gesendet[gesendet.length - 1].text;
    expect(status).toContain('Zustellungen: 1 in 7 Tagen, 1 in 28 Tagen — 1 gescheitert');
    expect(status).toContain('✕ Kumpel: Telegram sendMessage: 429 Too Many Requests');
    // 429 trägt nicht aus — der Chat ist noch da.
    expect(bot.listSubscribers().map(a => a.chatId).sort()).toEqual(['4711', '4712']);
  });

  it('/spiele schickt das nächste Spiel als Karte mit der Liste als Unterschrift', async () => {
    abonniere();
    legeSpiel();
    const fotos: Array<{ caption: string; filename?: string; keyboard?: unknown }> = [];
    const { deps, gesendet } = sammler();
    const mitBild = { ...deps, sendPhoto: vi.fn(async (_c: string, _p: Buffer, caption: string, filename?: string, keyboard?: unknown) => { fotos.push({ caption, filename, keyboard }); }) };
    await bot.handleHandballUpdate(update('/spiele'), mitBild);
    expect(fotos).toHaveLength(1);
    expect(fotos[0].filename).toBe('spiel.png');
    expect(fotos[0].caption).toContain('nächste Spiele');
    expect(fotos[0].keyboard).toBeTruthy();
    expect(gesendet).toHaveLength(0);
  });
});

describe('Befunde vom ersten Abend', () => {
  it('kürzt den Bericht auf das Fazit mit Knopf, /bericht voll bringt alles', async () => {
    abonniere();
    legeSpiel({ starts_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), status: 'finished', score_home: 30, score_away: 22,
      report_text: 'Einleitung.\n\n## Erste Halbzeit\n\nViel los.\n\n## Fazit\n\nVerdient gewonnen.' });
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/bericht'), deps);
    expect(gesendet[0].text).toContain('<b>Fazit</b>');
    expect(gesendet[0].text).toContain('Verdient gewonnen.');
    expect(gesendet[0].text).not.toContain('Viel los');
    expect(gesendet[0].text).toContain('Gekürzt');
    const kb = gesendet[0].keyboard as { inline_keyboard: Array<Array<{ callback_data?: string }>> };
    expect(kb.inline_keyboard[0][0].callback_data).toBe('cmd:bericht:voll');
    await bot.handleHandballUpdate(update('/bericht voll'), deps);
    expect(gesendet[1].text).toContain('Viel los');
    expect(gesendet[1].text).not.toContain('Gekürzt');
  });

  it('nimmt für Spieler ohne Kader-Nummer die zuletzt getragene und markiert Torhüter', async () => {
    abonniere();
    legeKader();
    const now = new Date().toISOString();
    dbRef.insert(schemaRef.handball_roster).values({ id: `${TEAM}:p-block`, team_id: TEAM, player_id: 'p-block', first_name: 'Maximilian', last_name: 'Block', number: null, role: 'player', season_id: 2627, updated_at: now }).run();
    legeSpiel({ match_id: 'alt', status: 'finished', starts_at: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString() });
    legeSpiel({ match_id: 'neu', status: 'finished', starts_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() });
    dbRef.insert(schemaRef.handball_match_player).values([
      { id: `${TEAM}:alt:p-block`, team_id: TEAM, match_id: 'alt', player_id: 'p-block', number: 12, is_goalkeeper: false, goals: 2, seven_meter_goals: 0, seven_meter_attempts: 0, two_minutes: 0, updated_at: now },
      { id: `${TEAM}:neu:p-block`, team_id: TEAM, match_id: 'neu', player_id: 'p-block', number: 14, is_goalkeeper: false, goals: 2, seven_meter_goals: 0, seven_meter_attempts: 0, two_minutes: 0, updated_at: now },
      { id: `${TEAM}:neu:p-raab`, team_id: TEAM, match_id: 'neu', player_id: 'p-raab', number: 21, is_goalkeeper: true, goals: 0, seven_meter_goals: 0, seven_meter_attempts: 0, two_minutes: 0, updated_at: now },
    ]).run();
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/kader'), deps);
    expect(gesendet[0].text).toContain('14* Maximilian Block');
    expect(gesendet[0].text).toContain('21  Jan Raab (TW)');
    expect(gesendet[0].text).toContain('Eine Nummer (*) fehlen im Kader');
    // Die Bilanz zeigt den Verlauf.
    await bot.handleHandballUpdate(update('/spieler Block'), deps);
    expect(gesendet[1].text).toContain('4 Tore in 2 Spielen · 2,0 pro Spiel');
    expect(gesendet[1].text).toContain('Tore je Spiel: 2 · 2');
  });

  it('zeigt in den Ergebnissen Halbzeit und besten Torschützen, mit Jahr bei großem Abstand', async () => {
    abonniere();
    legeKader();
    const now = new Date().toISOString();
    const alt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    legeSpiel({ match_id: 'a', status: 'finished', score_home: 30, score_away: 22, halftime_home: 15, halftime_away: 11, starts_at: alt });
    dbRef.insert(schemaRef.handball_match_player).values({ id: `${TEAM}:a:p-lieck`, team_id: TEAM, match_id: 'a', player_id: 'p-lieck', number: 25, is_goalkeeper: false, goals: 9, seven_meter_goals: 0, seven_meter_attempts: 0, two_minutes: 0, updated_at: now }).run();
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/ergebnisse'), deps);
    expect(gesendet[0].text).toMatch(/✅ \w+\., \d{2}\.\d{2}\.\d{4} H HV Erftstadt 30:22 \(HZ 15:11\) · Lieck 9/);
  });

  it('graut in der Tabelle Mannschaften mit weniger Spielen aus', () => {
    const team = { team_id: TEAM, name: 'HSG Wölfe Voreifel', label: 'HSG Wölfe Voreifel', championship_name: null, next_match: null, last_match: null, matches: [], standings: [] };
    const rows = [
      { round: 3, position: 1, teamId: TEAM, teamName: 'HSG Wölfe Voreifel', played: 3, won: 3, drawn: 0, lost: 0, goalsFor: 106, goalsAgainst: 87, goalsDiff: 19, points: 6 },
      { round: 3, position: 2, teamId: '96300', teamName: 'HV Erftstadt', played: 2, won: 2, drawn: 0, lost: 0, goalsFor: 80, goalsAgainst: 70, goalsDiff: 10, points: 4 },
    ];
    const t = bot.textTabelle(team, { phase_id: 1, competition_name: 'K', fetched_at: '', rows, previous_rows: null, history_rows: [] });
    expect(t).toContain(' 2*');
    expect(t).toContain('weniger Spiele als die Spitze');
  });
});

describe('Tabellenbewegung am Spieltag', () => {
  it('misst am Stand nach dem vorigen Spieltag und nicht am Zwischenstand des Abrufs davor', async () => {
    legeSpiel({ status: 'finished', score_home: 30, score_away: 22 });
    const now = new Date().toISOString();
    const z = (round: number, position: number, teamId: string, points: number) => ({
      round, position, teamId, teamName: teamId === TEAM ? 'HSG Wölfe Voreifel' : 'GTV', played: round, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalsDiff: 0, points,
    });
    dbRef.insert(schemaRef.handball_standings).values({
      phase_id: 12800, season_id: 2627, competition_name: 'Kreisoberliga mB', fetched_at: now,
      payload: JSON.stringify([z(3, 1, 'gtv', 6), z(3, 2, TEAM, 6)]),
      // Der Abruf davor sah die Wölfe kurz auf 1 — der Erste hatte noch nicht gespielt.
      previous_payload: JSON.stringify([z(3, 1, TEAM, 6), z(3, 2, 'gtv', 4)]),
      previous_fetched_at: now,
      history_payload: JSON.stringify([z(1, 1, 'gtv', 2), z(1, 2, TEAM, 2), z(2, 1, 'gtv', 4), z(2, 2, TEAM, 4), z(3, 1, 'gtv', 6), z(3, 2, TEAM, 6)]),
    }).run();
    const { handballOverview } = await import('../lib/handballTeam');
    const team = handballOverview().teams[0];
    expect(bot.tabellenBewegung(team)).toBe('Weiter Platz 2, 0 Punkte hinter Platz 1');
    // Das Tabellenbild trägt dann keinen Pfeil an der eigenen Zeile.
    const svg = bot.bildTabelle(team, team.standings[0]);
    expect(svg).not.toContain('▼');
    expect(svg).not.toContain('▲');
  });

  it('nennt den Bot-Link erst nach der Registrierung, mit Einladungscode als start-Parameter', async () => {
    expect(bot.handballBotLink()).toBeNull();
    trageTeamEin({ bot_invite_code: 'woelfe 26' }, '123:settings-token');
    telegramQuelle();
    await bot.activateHandballBot();
    expect(bot.handballBotLink()).toBe('https://t.me/woelfe_bot?start=woelfe%2026');
  });
});

describe('Token aus der Umgebung', () => {
  it('kennt den Bot nur mit TELEGRAM_BOT_TOKEN und registriert ihn beim Start', async () => {
    expect(bot.isHandballBotEnabled()).toBe(false);
    expect((await bot.registerHandballBotAtBoot()).status).toBe('skipped');
    expect(await bot.activateHandballBot()).toBeNull();
    process.env.TELEGRAM_BOT_TOKEN = 'env-token';
    expect(bot.getHandballBotToken()).toBe('env-token');
    const methoden = telegramQuelle();
    const r = await bot.registerHandballBotAtBoot();
    expect(r.status).toBe('registered');
    expect((r as { url: string }).url).toBe(`https://todo.test.local/telegram/webhook/${bot.ensureHandballBotSecrets().webhookPathSecret}`);
    expect(methoden).toEqual(['setWebhook', 'setMyCommands', 'getMe']);
    expect(bot.botRegistrationState()).toEqual({ source: 'env', registeredHere: true, storedFor: null });
  });
});

describe('Nachrichtenlänge', () => {
  it('schneidet an Absätzen, sonst an Zeilen, nie mitten im Wort', () => {
    const absatz = 'x'.repeat(1500);
    const text = [absatz, absatz, absatz].join('\n\n');
    const teile = bot.stuecke(text, 4000);
    expect(teile).toHaveLength(2);
    expect(teile[0]).toBe([absatz, absatz].join('\n\n'));
    expect(teile[1]).toBe(absatz);
    expect(bot.stuecke('kurz')).toEqual(['kurz']);
  });
});

describe('Matchday-Optik', () => {
  it('die Hilfe kennt nur noch Torjäger, nicht Torschützen — auch unter dem Endstand', () => {
    const hilfe = JSON.stringify(bot.hilfeTastatur());
    expect(hilfe).toContain('cmd:torjaeger');
    expect(hilfe).not.toContain('Torschützen');
    expect(hilfe).not.toContain('"cmd:spieler"');
    const endstand = JSON.stringify(bot.endstandTastatur({ url: 'https://x', report_url: null } as never));
    expect(endstand).toContain('Torjäger');
    expect(endstand).not.toContain('Torschützen');
  });

  it('schickt den Endstand als Animation, wenn der Weg da ist, und als Foto, wenn Telegram sie ablehnt', { timeout: 30_000 }, async () => {
    abonniere('4711'); abonniere('4712');
    legeSpiel({ starts_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(), status: 'finished', score_home: 30, score_away: 22, halftime_home: 15, halftime_away: 11 });
    legeKader();
    aufstellungsQuelle([{ player: { id: 'p-lieck' }, number: 25, goals: 7, is_captain: true }]);
    const animationen: Array<{ chatId: string; gif: Buffer; caption: string; filename?: string }> = [];
    const fotos: Array<{ chatId: string; filename?: string }> = [];
    const { deps } = sammler();
    const mitBild = {
      ...deps,
      sendPhoto: vi.fn(async (chatId: string, _png: Buffer, _caption: string, filename?: string) => { fotos.push({ chatId, filename }); return 7; }),
      sendAnimation: vi.fn(async (chatId: string, gif: Buffer, caption: string, filename?: string) => {
        if (chatId === '4712') throw new TelegramApiError('sendAnimation', 413, 'Animation zu groß');
        animationen.push({ chatId, gif, caption, filename });
        return 8;
      }),
    };
    await bot.pushHandballBot(new Date(), mitBild);
    // Chat 4711 bekommt das GIF, Chat 4712 nach dem 413 das Foto — beide zählen als zugestellt.
    expect(animationen).toHaveLength(1);
    expect(animationen[0]).toMatchObject({ chatId: '4711', filename: 'endstand.gif' });
    expect(animationen[0].gif.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    expect(animationen[0].caption).toContain('HSG Wölfe Voreifel gewinnt 30:22');
    expect(fotos).toEqual([{ chatId: '4712', filename: 'endstand.png' }]);
    expect(dbRef.select().from(schemaRef.handball_bot_delivery).all().filter(z => z.kind === 'endstand' && z.ok === 1)).toHaveLength(2);
    // Der Kapitän aus der Aufstellung steht im Kader.
    const teamMod = await import('../lib/handballTeam');
    expect(teamMod.rosterFor(TEAM).find(r => r.playerId === 'p-lieck')?.captain).toBe(true);
    expect(teamMod.rosterFor(TEAM).find(r => r.playerId === 'p-raab')?.captain).toBe(false);
  });
});

describe('Wertung, Saisonkarte, Zeitzone im Betriebsstand', () => {
  const vorTagen = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  it('meldet ein gewertetes Spiel (Status „other" mit Toren) als Endstand mit „(gewertet)" — einmal', async () => {
    abonniere();
    legeSpiel({ status: 'other', status_name: 'Abgebrochen', score_home: 20, score_away: 0, starts_at: vorTagen(2) });
    quelle({});
    const { deps, gesendet } = sammler();
    await bot.pushHandballBot(new Date(), deps);
    const endstand = gesendet.filter(g => g.text.startsWith('🏁'));
    expect(endstand).toHaveLength(1);
    expect(endstand[0].text).toContain('gewinnt 20:0 (gewertet)');
    expect(endstand[0].text).toContain('„Abgebrochen"');
    await bot.pushHandballBot(new Date(), deps);
    expect(gesendet.filter(g => g.text.startsWith('🏁'))).toHaveLength(1);
  });

  it('meldet ein Spiel, das nur die Tabelle zählt, als gewertet ohne Ergebnis', async () => {
    abonniere();
    legeTabelle(); // die Wölfe mit drei Spielen
    legeSpiel({ match_id: 'a', status: 'finished', score_home: 30, score_away: 22, starts_at: vorTagen(20) });
    legeSpiel({ match_id: 'b', status: 'finished', score_home: 25, score_away: 20, starts_at: vorTagen(13) });
    legeSpiel({ match_id: 'c', status: 'cancelled', status_name: 'Suspendido', starts_at: vorTagen(6) });
    // Die alten Endstände sollen hier nicht stören.
    for (const id of ['a', 'b']) dbRef.insert(schemaRef.handball_bot_sent).values({ id: `${TEAM}:${id}:result`, sent_at: new Date().toISOString() }).run();
    quelle({});
    const { deps, gesendet } = sammler();
    await bot.pushHandballBot(new Date(), deps);
    const endstand = gesendet.filter(g => g.text.startsWith('🏁'));
    expect(endstand).toHaveLength(1);
    expect(endstand[0].text).toContain('Spiel gewertet');
    expect(endstand[0].text).toContain('die Tabelle zählt es aber');
  });

  it('schickt die Saisonkarte einmal, wenn das letzte Spiel durch ist — nicht mitten in der Saison, nicht nach sieben Tagen', async () => {
    abonniere();
    legeTabelle();
    legeSpiel({ match_id: 'a', status: 'finished', score_home: 30, score_away: 22, starts_at: vorTagen(20) });
    legeSpiel({ match_id: 'b', status: 'scheduled', starts_at: new Date(Date.now() + 86_400_000).toISOString() });
    for (const id of ['a']) dbRef.insert(schemaRef.handball_bot_sent).values({ id: `${TEAM}:${id}:result`, sent_at: new Date().toISOString() }).run();
    quelle({});
    const { deps, gesendet } = sammler();
    await bot.pushHandballBot(new Date(), deps);
    expect(gesendet.filter(g => g.text.includes('Die Saison ist vorbei'))).toHaveLength(0);

    // Das letzte Spiel ist gespielt (vor drei Tagen): Karte an alle, einmal.
    dbRef.update(schemaRef.handball_team_match).set({ status: 'finished', score_home: 28, score_away: 20, starts_at: vorTagen(3) })
      .where(eq(schemaRef.handball_team_match.match_id, 'b')).run();
    dbRef.insert(schemaRef.handball_bot_sent).values({ id: `${TEAM}:b:result`, sent_at: new Date().toISOString() }).run();
    const fotos: Array<{ caption: string; filename?: string }> = [];
    const mitBild = { ...deps, sendPhoto: vi.fn(async (_c: string, _p: Buffer, caption: string, filename?: string) => { fotos.push({ caption, filename }); }) };
    await bot.pushHandballBot(new Date(), mitBild);
    expect(fotos).toHaveLength(1);
    expect(fotos[0].filename).toBe('saison.png');
    expect(fotos[0].caption).toContain('Die Saison ist vorbei');
    expect(dbRef.select().from(schemaRef.handball_bot_delivery).all().filter(z => z.kind === 'saison')).toHaveLength(1);
    await bot.pushHandballBot(new Date(), mitBild);
    expect(fotos).toHaveLength(1);
  }, 30_000);

  it('schickt keine Saisonkarte, wenn das Saisonende länger als sieben Tage her ist', async () => {
    abonniere();
    legeSpiel({ match_id: 'a', status: 'finished', score_home: 30, score_away: 22, starts_at: vorTagen(9) });
    dbRef.insert(schemaRef.handball_bot_sent).values({ id: `${TEAM}:a:result`, sent_at: new Date().toISOString() }).run();
    quelle({});
    const { deps, gesendet } = sammler();
    await bot.pushHandballBot(new Date(), deps);
    expect(gesendet.filter(g => g.text.includes('Saison ist vorbei'))).toHaveLength(0);
  });

  it('/saison trägt den Knopf „Saisonkarte", /saisonkarte schickt die Karte', async () => {
    abonniere();
    legeTabelle();
    legeSpiel({ match_id: 'a', status: 'finished', score_home: 30, score_away: 22, starts_at: vorTagen(20) });
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/saison'), deps);
    expect(JSON.stringify(gesendet[0].keyboard)).toContain('cmd:saisonkarte');
    const fotos: Array<{ filename?: string }> = [];
    const mitBild = { ...deps, sendPhoto: vi.fn(async (_c: string, _p: Buffer, _caption: string, filename?: string) => { fotos.push({ filename }); }) };
    await bot.handleHandballUpdate(update('/saisonkarte'), mitBild);
    expect(fotos).toEqual([{ filename: 'saison.png' }]);
    const svg = bot.bildSaison(await import('../lib/handballTeam').then(m => m.handballOverview().teams[0]))!;
    expect(svg).toContain('SAISONBILANZ');
    expect(svg).toContain('1-0-0');
    expect(svg).toContain('30:22');
    expect(svg).toContain('von 2');
  }, 30_000);

  it('/status nennt die Zeitzone und den Webhook', async () => {
    trageTeamEin({ bot_admin_chat_id: '4711' });
    abonniere('4711');
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/status', 4711), deps);
    expect(gesendet[0].text).toContain('Zeitzone: ungeprüft');
    expect(gesendet[0].text).toContain('Webhook: kein Token');
    legeSpiel({ status: 'finished', score_home: 30, score_away: 22, starts_at: vorTagen(3), tz_check: 'confirmed' });
    await bot.handleHandballUpdate(update('/status', 4711), deps);
    expect(gesendet[1].text).toContain('Zeitzone: bestätigt (an 1 Spiel)');
  });

  it('färbt die Bilder in den Farben der Konfiguration', async () => {
    trageTeamEin({ primary_color: '#8B0000', secondary_color: '#a52a2a', accent_color: '#ffd700' });
    legeTabelle();
    legeSpiel({ match_id: 'a', status: 'finished', score_home: 30, score_away: 22, starts_at: vorTagen(20) });
    const team = (await import('../lib/handballTeam')).handballOverview().teams[0];
    const tabelle = bot.bildTabelle(team, team.standings[0]);
    expect(tabelle).toContain('#8b0000');
    expect(tabelle).toContain('#ffd700');
    expect(tabelle).not.toContain('#003e51');
    expect(bot.bildSaison(team)).toContain('#8b0000');
  });
});

describe('Sechste Runde: Telegram-Funktionen', () => {
  /** Telegram-API mitschneiden: Methode und JSON-Rumpf je Aufruf. */
  function telegramMitschnitt(getMe: Record<string, unknown> = { id: 1, username: 'woelfe_bot', supports_inline_queries: false }) {
    const aufrufe: Array<{ method: string; body: Record<string, unknown> }> = [];
    global.fetch = vi.fn().mockImplementation((url: string, init?: { body?: unknown }) => {
      const m = /api\.telegram\.org\/bot[^/]+\/(\w+)/.exec(String(url));
      if (!m) return Promise.resolve(antwort('<html></html>'));
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>; } catch { body = {}; }
      aufrufe.push({ method: m[1], body });
      return Promise.resolve(antwort({ ok: true, result: m[1] === 'getMe' ? getMe : true }));
    }) as unknown as typeof fetch;
    return aufrufe;
  }

  function setzeConfig(extra: Record<string, unknown>) {
    if ('bot_auto_description' in extra) process.env.BOT_AUTO_DESCRIPTION = String(extra.bot_auto_description);
    if ('bot_admin_chat_id' in extra) process.env.TELEGRAM_ADMIN_CHAT_IDS = String(extra.bot_admin_chat_id);
  }

  it('Admin-Befehle stehen nur im Menü der Admin-Chats, ausgetragene verlieren es; der Webhook nimmt Inline-Anfragen an', async () => {
    trageTeamEin({ bot_admin_chat_id: '4711, -100555' }, '123:settings-token');
    const aufrufe = telegramMitschnitt();
    await bot.activateHandballBot();
    const webhook = aufrufe.find(a => a.method === 'setWebhook')!;
    expect(webhook.body.allowed_updates).toEqual(expect.arrayContaining(['message', 'callback_query', 'my_chat_member', 'inline_query']));
    const menues = aufrufe.filter(a => a.method === 'setMyCommands');
    const befehle = (a: { body: Record<string, unknown> }) => (a.body.commands as Array<{ command: string }>).map(c => c.command);
    // Die Standardliste kennt die Betreiber-Befehle nicht …
    expect(menues[0].body.scope).toEqual({ type: 'default' });
    expect(befehle(menues[0])).not.toContain('status');
    expect(befehle(menues[0])).toContain('halle');
    // … die Admin-Chats bekommen Standard plus Betreiber, weil ein Chat-Scope die Standardliste ersetzt.
    expect(menues.slice(1).map(a => a.body.scope)).toEqual([{ type: 'chat', chat_id: '4711' }, { type: 'chat', chat_id: '-100555' }]);
    expect(befehle(menues[1])).toEqual(expect.arrayContaining(['tabelle', 'status', 'rundruf', 'erledigt']));
    // Ein Admin-Chat wird ausgetragen: Sein Menü wird zurückgesetzt, der andere bleibt.
    aufrufe.length = 0;
    setzeConfig({ bot_admin_chat_id: '4711' });
    await bot.refreshHandballAdminMenu();
    expect(aufrufe.map(a => `${a.method}:${(a.body.scope as { chat_id: string }).chat_id}`)).toEqual(['setMyCommands:4711', 'deleteMyCommands:-100555']);
    expect(dbRef.select().from(schemaRef.handball_bot_instance).get()?.admin_menu_chats).toBe('4711');
    // /status nennt den Inline-Modus aus getMe — hier aus, mit dem Weg zum Einschalten.
    abonniere('4711');
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/status', 4711), deps);
    expect(gesendet[0].text).toContain('Inline-Modus: aus — im BotFather mit /setinline einschalten');
  });

  it('zeigt „schickt ein Foto …" vor einem Bild, blockiert nie daran und schweigt bei Rundrufen', async () => {
    trageTeamEin({ bot_admin_chat_id: '4711' });
    abonniere('4711'); abonniere('4712');
    legeTabelle(); legeSpiel();
    const reihenfolge: string[] = [];
    const { deps } = sammler();
    const mitAnzeige = {
      ...deps,
      sendPhoto: vi.fn(async () => { reihenfolge.push('foto'); return 1; }),
      chatAction: vi.fn(async (_chatId: string, action: string) => { reihenfolge.push(action); throw new Error('Telegram antwortet nicht'); }),
    };
    await bot.handleHandballUpdate(update('/tabelle', 4711), mitAnzeige);
    expect(reihenfolge).toEqual(['upload_photo', 'foto']);
    mitAnzeige.chatAction.mockClear();
    await bot.handleHandballUpdate(update('/rundruf Hallo', 4711), mitAnzeige);
    expect(mitAnzeige.chatAction).not.toHaveBeenCalled();
    await bot.handleHandballUpdate(update('/ergebnisse', 4712), mitAnzeige);
    expect(mitAnzeige.chatAction).toHaveBeenCalledWith('4712', 'typing');
  });

  it('/rundruf behält Zeilenumbrüche', async () => {
    trageTeamEin({ bot_admin_chat_id: '4711' });
    abonniere('4711'); abonniere('4712');
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/rundruf Zeile 1\nZeile 2', 4711), deps);
    const an4712 = gesendet.find(g => g.chatId === '4712')!;
    expect(an4712.text).toContain('Zeile 1\nZeile 2');
  });

  it('schickt die Halle als Ort unter der Ankündigung und hinter dem Knopf „📍 Halle"', async () => {
    abonniere();
    legeSpiel({ starts_at: new Date(Date.now() + 50 * 60 * 1000).toISOString(), venue_lat: 50.6464842, venue_lon: 6.831915 });
    quelle({});
    const orte: Array<{ chatId: string; venue: Record<string, unknown> }> = [];
    const { deps, gesendet } = sammler();
    const mitOrt = { ...deps, sendVenue: vi.fn(async (chatId: string, venue: object) => { orte.push({ chatId, venue: venue as Record<string, unknown> }); }) };
    await bot.pushHandballBot(new Date(), mitOrt);
    expect(gesendet).toHaveLength(1);
    expect(orte).toEqual([{ chatId: '4711', venue: { latitude: 50.6464842, longitude: 6.831915, title: 'Sporthalle Heimerzheim', address: 'Schulstrasse 1, 53913 Swisttal' } }]);
    const kb = gesendet[0].keyboard as { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> };
    expect(kb.inline_keyboard[0][0].url).toContain('google.com/maps');
    expect(kb.inline_keyboard.flat().find(b => b.text === '📍 Halle')?.callback_data).toBe('cmd:halle:m1');
    await bot.handleHandballUpdate({ update_id: 77, callback_query: { id: 'cb', from: { id: 4711 }, data: 'cmd:halle:m1', message: { message_id: 1, chat: { id: 4711, type: 'private' } } } }, mitOrt);
    expect(orte).toHaveLength(2);
    // Ohne Koordinaten kein Knopf und kein Ort; /halle nennt dann die Anschrift.
    const { handballOverview } = await import('../lib/handballTeam');
    const m = { ...handballOverview().teams[0].matches[0], venue_lat: null, venue_lon: null };
    expect(JSON.stringify(bot.ankuendigungTastatur(m))).not.toContain('cmd:halle');
    dbRef.update(schemaRef.handball_team_match).set({ venue_lat: null, venue_lon: null }).run();
    await bot.handleHandballUpdate(update('/halle'), mitOrt);
    expect(orte).toHaveLength(2);
    expect(gesendet[gesendet.length - 1].text).toContain('📍 Sporthalle Heimerzheim, Schulstrasse 1');
  });

  it('Inline-Modus: Fremde bekommen nur „Bot starten", Abonnenten signierte Bilder je Suchwort', async () => {
    legeTabelle(); legeKader(); legeSpiel();
    const antworten: Array<{ id: string; results: Array<Record<string, unknown>>; opts: Record<string, unknown> }> = [];
    const { deps } = sammler();
    const mitInline = { ...deps, answerInline: vi.fn(async (id: string, results: object[], opts: object) => { antworten.push({ id, results: results as Array<Record<string, unknown>>, opts: opts as Record<string, unknown> }); }) };
    const anfrage = (von: number, query: string, id: string) => ({ update_id: Math.floor(Math.random() * 1e9), inline_query: { id, from: { id: von, first_name: 'X' }, query } });
    await bot.handleHandballUpdate(anfrage(999, 'tab', 'q1'), mitInline);
    expect(antworten[0]).toMatchObject({ id: 'q1', results: [], opts: { button: { text: 'Bot starten', start_parameter: 'inline' }, isPersonal: true } });
    abonniere('4711');
    await bot.handleHandballUpdate(anfrage(4711, 'tab', 'q2'), mitInline);
    expect(antworten[1].results.map(r => r.id)).toEqual(['tabelle:96254']);
    expect(antworten[1].opts).toMatchObject({ cacheTime: 300, isPersonal: true });
    const url = new URL(String(antworten[1].results[0].photo_url));
    expect(`${url.origin}${url.pathname}`).toBe('https://todo.test.local/inline/tabelle.jpg');
    expect(String(antworten[1].results[0].thumbnail_url)).toContain('vorschau=1');
    const [team, exp, t] = ['team', 'exp', 't'].map(k => url.searchParams.get(k) ?? '');
    expect(bot.pruefeInlineSignatur('tabelle', team, exp, t)).toBe(true);
    expect(bot.pruefeInlineSignatur('kader', team, exp, t)).toBe(false);
    expect(bot.pruefeInlineSignatur('tabelle', '1', exp, t)).toBe(false);
    expect(bot.pruefeInlineSignatur('tabelle', team, exp, t, Number(exp) * 1000 + 1)).toBe(false);
    // Ohne Suchtext alles, was es gerade gibt — kein Endstand ohne gespieltes Spiel.
    await bot.handleHandballUpdate(anfrage(4711, '', 'q3'), mitInline);
    expect(antworten[2].results.map(r => r.id)).toEqual(['tabelle:96254', 'spiel:96254', 'kader:96254']);
    await bot.handleHandballUpdate(anfrage(4711, 'kad', 'q4'), mitInline);
    expect(antworten[3].results.map(r => r.id)).toEqual(['kader:96254']);
  });

  it('Konfetti zum Sieg nur im Privatchat — und ohne Effekt noch einmal, wenn Telegram ihn ablehnt', async () => {
    abonniere('4711'); abonniere('-100123');
    legeSpiel({ starts_at: new Date(Date.now() - 90 * 60 * 1000).toISOString(), status: 'finished', score_home: 30, score_away: 22 });
    aufstellungsQuelle([]);
    const versuche: Array<{ chatId: string; effectId?: string }> = [];
    const deps = {
      send: vi.fn(async (chatId: string, _text: string, _kb?: unknown, extras?: { effectId?: string }) => {
        versuche.push({ chatId, effectId: extras?.effectId });
        if (extras?.effectId) throw new TelegramApiError('sendMessage', 400, 'Bad Request: EFFECT_ID_INVALID');
        return 1;
      }),
    };
    await bot.pushHandballBot(new Date(), deps);
    expect(versuche).toEqual([
      { chatId: '4711', effectId: bot.KONFETTI_EFFECT_ID },
      { chatId: '4711', effectId: undefined },
      { chatId: '-100123', effectId: undefined },
    ]);
    // Beide zugestellt, keiner ausgetragen.
    expect(dbRef.select().from(schemaRef.handball_bot_delivery).all().filter(z => z.kind === 'endstand' && z.ok === 1)).toHaveLength(2);
    expect(bot.listSubscribers()).toHaveLength(2);
  });

  it('schickt mehrere Bilder als Album, fällt bei Ablehnung auf Einzelbilder zurück, ein Bild bleibt ein Foto', { timeout: 30_000 }, async () => {
    abonniere();
    legeTabelle(); legeSpiel();
    dbRef.insert(schemaRef.handball_standings).values({
      phase_id: 12900, season_id: 2627, competition_name: 'Kreispokal mB', fetched_at: new Date().toISOString(),
      payload: JSON.stringify([{ round: 1, position: 1, teamId: TEAM, teamName: 'HSG Wölfe Voreifel', played: 1, won: 1, drawn: 0, lost: 0, goalsFor: 30, goalsAgainst: 20, goalsDiff: 10, points: 2 }]),
    }).run();
    legeSpiel({ match_id: 'm2', phase_id: 12900, competition_name: 'Kreispokal mB' });
    const alben: Array<Array<{ png: Buffer; filename: string; caption?: string }>> = [];
    const fotos: string[] = [];
    const { deps } = sammler();
    let ablehnen = false;
    const mitAlbum = {
      ...deps,
      sendPhoto: vi.fn(async (_c: string, _p: Buffer, caption: string) => { fotos.push(caption); return 1; }),
      sendMediaGroup: vi.fn(async (_c: string, photos: Array<{ png: Buffer; filename: string; caption?: string }>) => {
        if (ablehnen) throw new TelegramApiError('sendMediaGroup', 400, 'Bad Request: failed to send message #1');
        alben.push(photos);
      }),
    };
    await bot.handleHandballUpdate(update('/tabelle'), mitAlbum);
    expect(alben).toHaveLength(1);
    expect(alben[0]).toHaveLength(2);
    expect(alben[0][0].caption).toContain('Kreisoberliga mB');
    expect(alben[0][0].caption).toContain('Kreispokal mB');
    expect(alben[0][1].caption).toBeUndefined();
    expect(alben[0][0].png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(fotos).toEqual([]);
    // Telegram lehnt das Album ab: dieselben Bilder einzeln.
    ablehnen = true;
    await bot.handleHandballUpdate(update('/tabelle'), mitAlbum);
    expect(fotos).toHaveLength(2);
    // Ein Bild ist kein Album.
    ablehnen = false; fotos.length = 0;
    await bot.handleHandballUpdate(update('/spiele'), mitAlbum);
    expect(alben).toHaveLength(1);
    expect(fotos).toHaveLength(1);
  });

  it('/status nennt, was Telegram über den Webhook sagt', async () => {
    trageTeamEin({ bot_admin_chat_id: '4711' });
    abonniere('4711');
    process.env.TELEGRAM_BOT_TOKEN = '123:env';
    global.fetch = vi.fn().mockImplementation((url: string) => {
      const m = /bot[^/]+\/(\w+)/.exec(String(url));
      const result = m?.[1] === 'getWebhookInfo' ? { url: 'https://dev.example/telegram/webhook/x', pending_update_count: 0 } : { id: 1, username: 'woelfe_bot', supports_inline_queries: true };
      return Promise.resolve(antwort({ ok: true, result }));
    }) as unknown as typeof fetch;
    const { deps, gesendet } = sammler();
    await bot.handleHandballUpdate(update('/status', 4711), deps);
    expect(gesendet[0].text).toContain('bei Telegram: zeigt auf dev.example');
    expect(gesendet[0].text).toContain('Inline-Modus: an');
    expect(bot.getHandballBotHealth().error).toContain('zeigt auf dev.example');
  });

  it('pflegt Beschreibung und Kurzbeschreibung aus dem Stand — nur bei Änderung, abschaltbar', async () => {
    trageTeamEin({}, '123:settings-token');
    legeTabelle(); legeSpiel({ starts_at: '2026-10-03T12:00:00.000Z' });
    const aufrufe = telegramMitschnitt();
    expect((await bot.pflegeHandballBotBeschreibung()).status).toBe('gesetzt');
    expect(aufrufe.map(a => a.method)).toEqual(['setMyDescription', 'setMyShortDescription']);
    const lang = String(aufrufe[0].body.description);
    const kurz = String(aufrufe[1].body.short_description);
    expect(lang.length).toBeLessThanOrEqual(512);
    expect(kurz.length).toBeLessThanOrEqual(120);
    expect(lang).toContain('Tabelle: 1. Platz, 6 Punkte nach 3 Spielen');
    expect(lang).toContain('Nächstes Spiel: Sa., 03.10. 14:00 Uhr gegen HV Erftstadt (Heimspiel)');
    expect(kurz).toBe('🤾 HSG Wölfe Voreifel · Platz 1 · Nächstes: Sa., 03.10. vs HV Erftstadt (H)');
    // Unverändert: kein Aufruf.
    aufrufe.length = 0;
    expect((await bot.pflegeHandballBotBeschreibung()).status).toBe('unveraendert');
    expect(aufrufe).toEqual([]);
    // Abgeschaltet: Was im BotFather steht, bleibt.
    dbRef.update(schemaRef.handball_team_match).set({ away_name: 'TV Palmersheim' }).run();
    setzeConfig({ bot_auto_description: 'false' });
    expect((await bot.pflegeHandballBotBeschreibung()).status).toBe('aus');
    expect(aufrufe).toEqual([]);
    // Lange Namen: hart begrenzt.
    const { handballOverview } = await import('../lib/handballTeam');
    const team = handballOverview().teams[0];
    const lange = [{ ...team, name: 'Handballspielgemeinschaft '.repeat(8) }, { ...team, team_id: 'x', name: 'Zweite Mannschaft '.repeat(10) }];
    expect(bot.textKurzbeschreibung(lange).length).toBeLessThanOrEqual(120);
    expect(bot.textBeschreibung([...lange, ...lange, ...lange]).length).toBeLessThanOrEqual(512);
  });
});
