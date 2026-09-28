/**
 * Meldungen an den Betreiber — der Ersatz für Todotecks `notifySyncError`.
 *
 * In Todoteck ging ein Ausfall des Abrufs als Anlass `sync_error` an jeden
 * Nutzer, mit Entprellung im Benachrichtigungsdienst. Hier gibt es keine
 * Nutzer; es gibt die Admin-Chats des Telegram-Bots (`TELEGRAM_ADMIN_CHAT_IDS`).
 * Dorthin geht je Schlüssel **eine** Meldung, bis der Zustand sich ändert:
 * derselbe Text ein zweites Mal wird verschluckt, ein anderer Text (neue
 * Ursache) geht raus, und `entwarnung` schließt den Fall — beim nächsten
 * Fehler kommt die Meldung wieder. Ohne Bot-Token oder Admin-Chat bleibt es
 * beim Log; der Fehler steht ohnehin in `/api/health` und in `/status`.
 */
import { adminChatIds, botToken } from '../config';
import { sendMessage, escapeHtml } from './telegramClient';
import { serviceLog } from './serviceLogger';

const gemeldet = new Map<string, string>();

export interface AlertDeps {
  send: (chatId: string, text: string) => Promise<void>;
}

const DEFAULT_DEPS: AlertDeps = {
  send: async (chatId, text) => {
    const token = botToken();
    if (!token) return;
    await sendMessage(token, { chatId, text });
  },
};

/** Ein Fehler mit Schlüssel — einmal je Zustand an die Admin-Chats. */
export async function meldeBetreiber(key: string, titel: string, text: string, deps: AlertDeps = DEFAULT_DEPS): Promise<boolean> {
  if (gemeldet.get(key) === text) return false;
  gemeldet.set(key, text);
  const chats = adminChatIds();
  if (chats.size === 0 || !botToken()) return false;
  let raus = false;
  for (const chatId of chats) {
    try {
      await deps.send(chatId, `⚠️ <b>${escapeHtml(titel)}</b>\n${escapeHtml(text)}`);
      raus = true;
    } catch (err) {
      serviceLog.warn({ chat: chatId, err: err instanceof Error ? err.message : String(err) }, '[alerts] Betreiber nicht erreichbar');
    }
  }
  return raus;
}

/** Der Fall ist erledigt — die nächste Meldung desselben Schlüssels geht wieder raus. */
export function entwarnung(key: string): void {
  gemeldet.delete(key);
}

/** Nur für Tests. */
export function __resetAlertsForTests(): void {
  gemeldet.clear();
}
