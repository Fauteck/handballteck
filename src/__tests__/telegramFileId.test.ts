import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { unlinkSync } from 'fs';

/**
 * PRF-2-004: Ein Bild geht beim Rundruf einmal hoch; jeder weitere Chat
 * bekommt nur die `file_id` aus der ersten Antwort. Lehnt Telegram die
 * `file_id` ab, wird neu hochgeladen.
 */

const DB_FILE = `/tmp/handball-fileid-${process.pid}.db`;
process.env.DATABASE_PATH = DB_FILE;
process.env.PUBLIC_URL = 'https://todo.test.local';
process.env.TELEGRAM_BOT_TOKEN = '123:test';

const ORIGINAL_FETCH = global.fetch;
let senders: typeof import('../lib/handballBot')['__defaultSendersForTests'];

type Aufruf = { method: string; multipart: boolean; body: Record<string, unknown> | null };
const aufrufe: Aufruf[] = [];
let lehneFileIdAb = false;

beforeAll(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
  ({ __defaultSendersForTests: senders } = await import('../lib/handballBot'));
});

afterAll(() => {
  global.fetch = ORIGINAL_FETCH;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try { unlinkSync(DB_FILE); } catch { /* egal */ }
});

beforeEach(() => {
  aufrufe.length = 0;
  lehneFileIdAb = false;
  let n = 0;
  global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    const multipart = init?.body instanceof FormData;
    const body = multipart ? null : JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    aufrufe.push({ method, multipart, body });
    if (!multipart && lehneFileIdAb) {
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' }), { status: 400 });
    }
    n++;
    const result = method === 'sendPhoto'
      ? { message_id: n, chat: { id: 1, type: 'private' }, photo: [{ file_id: 'klein' }, { file_id: 'foto-gross' }] }
      : { message_id: n, chat: { id: 1, type: 'private' }, animation: { file_id: 'gif-1' } };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
});

describe('Telegram: dasselbe Bild nur einmal hochladen', () => {
  it('lädt ein Foto für drei Chats genau einmal hoch, danach die größte file_id', async () => {
    const png = Buffer.from('png-bytes');
    for (const chat of ['1', '2', '3']) await senders.sendPhoto(chat, png, 'Endstand', 'endstand.png');
    expect(aufrufe.filter(a => a.multipart)).toHaveLength(1);
    const wieder = aufrufe.filter(a => !a.multipart);
    expect(wieder).toHaveLength(2);
    expect(wieder.every(a => a.method === 'sendPhoto' && a.body!.photo === 'foto-gross')).toBe(true);
    expect(wieder.map(a => a.body!.chat_id)).toEqual(['2', '3']);
  });

  it('macht es bei Animationen ebenso', async () => {
    const gif = Buffer.from('gif-bytes');
    await senders.sendAnimation!('1', gif, 'Endstand');
    await senders.sendAnimation!('2', gif, 'Endstand');
    expect(aufrufe.filter(a => a.multipart)).toHaveLength(1);
    expect(aufrufe[1]).toMatchObject({ method: 'sendAnimation', multipart: false, body: { animation: 'gif-1' } });
  });

  it('lädt neu hoch, wenn Telegram die file_id ablehnt', async () => {
    const png = Buffer.from('anderes-png');
    await senders.sendPhoto('1', png, 'x');
    lehneFileIdAb = true;
    await senders.sendPhoto('2', png, 'x');
    expect(aufrufe.map(a => a.multipart)).toEqual([true, false, true]);
  });
});
