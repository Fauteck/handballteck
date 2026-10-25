import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { unlinkSync } from 'fs';

/**
 * SEC-3-004: Wie ein Push ohne HTTP-Status gewertet wird. Ein Netzwerkfehler
 * kann sich erholen (`retry`); eine Domain, die es nicht gibt, oder ein
 * Schlüssel, mit dem sich nicht verschlüsseln lässt, nicht (`gone`, die Zeile
 * geht). Vorher blieb so eine Zeile zwölf Fehlversuche lang stehen.
 */

const DB_FILE = `/tmp/handball-webpush-${process.pid}.db`;
process.env.DATABASE_PATH = DB_FILE;
process.env.PUBLIC_URL = 'https://todo.test.local';

const sendNotification = vi.fn();
vi.mock('web-push', async importOriginal => {
  const echt = (await importOriginal()) as { default: Record<string, unknown> };
  return { default: { ...echt.default, sendNotification: (...a: unknown[]) => sendNotification(...a) } };
});

let sendPush: typeof import('../lib/webPush')['sendPush'];
const ziel = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'k', auth: 'a' };
const fehler = (felder: Record<string, unknown>) => Object.assign(new Error('kaputt'), felder);

beforeAll(async () => {
  const webpush = (await import('web-push')).default;
  const paar = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = paar.publicKey;
  process.env.VAPID_PRIVATE_KEY = paar.privateKey;
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
  ({ sendPush } = await import('../lib/webPush'));
});

afterAll(() => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  try { unlinkSync(DB_FILE); } catch { /* egal */ }
});

describe('Web-Push: Fehler ohne HTTP-Status', () => {
  it('wertet eine unbekannte Domain und einen unbrauchbaren Schlüssel als tot', async () => {
    sendNotification.mockRejectedValueOnce(fehler({ code: 'ENOTFOUND' }));
    expect(await sendPush(ziel, { title: 't', body: 'b' })).toMatchObject({ status: 'gone', reason: 'ENOTFOUND' });
    sendNotification.mockRejectedValueOnce(new Error('The subscription p256dh value should be 65 bytes long.'));
    expect((await sendPush(ziel, { title: 't', body: 'b' })).status).toBe('gone');
  });

  it('versucht es nach Netzwerkfehlern und HTTP-Fehlern des Dienstes später noch einmal', async () => {
    for (const code of ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']) {
      sendNotification.mockRejectedValueOnce(fehler({ code }));
      expect((await sendPush(ziel, { title: 't', body: 'b' })).status).toBe('retry');
    }
    sendNotification.mockRejectedValueOnce(fehler({ statusCode: 503 }));
    expect(await sendPush(ziel, { title: 't', body: 'b' })).toMatchObject({ status: 'retry', reason: 'HTTP 503' });
    sendNotification.mockRejectedValueOnce(fehler({ statusCode: 410 }));
    expect((await sendPush(ziel, { title: 't', body: 'b' })).status).toBe('gone');
  });
});
