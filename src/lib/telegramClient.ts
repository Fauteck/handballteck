/**
 * Minimaler Client fuer die Telegram-Bot-API (siehe
 * docs/telegram-bot-strategy.md). Deckt genau die Methoden ab, die der Bot
 * braucht: antworten, Inline-Tastaturen bedienen, Sprachnachrichten holen und
 * den Webhook registrieren.
 *
 * Zwei bewusste Festlegungen:
 *  - **Parse-Mode HTML statt MarkdownV2.** MarkdownV2 escapet aggressiv (jedes
 *    `.`, `-`, `!` …) — bei deutschen Freitexten aus Transkripten ist das eine
 *    Fehlerquelle ohne Gewinn. HTML braucht nur `escapeHtml` fuer drei Zeichen
 *    (§11.9).
 *  - **Retry nur fuer die Antwort, nie fuer die Aktion.** `sendMessage` und
 *    Freunde wiederholen transiente Fehler selbst mit Backoff; der Aufrufer
 *    darf daraus niemals ableiten, die Schreibaktion zu wiederholen (§11.6).
 *
 * Der Bot-Token ist ein globales Betreiber-Secret aus `TELEGRAM_BOT_TOKEN`
 * und steckt in der URL — deshalb taucht er in keiner Log-Zeile dieses Moduls
 * auf (Fehlertexte tragen nur Methode + Status).
 */

const API_BASE = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Backoff vor dem 2. bzw. 3. Versuch. */
const RETRY_DELAYS_MS = [500, 2000];
/** HTTP-Status, bei denen ein erneuter Versuch sinnvoll ist. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number | null,
    readonly description: string,
    /** `parameters.retry_after` aus einer 429-Antwort, in Sekunden. */
    readonly retryAfter: number | null = null,
  ) {
    super(`Telegram ${method}: ${status ?? 'Netzwerkfehler'} ${description}`);
    this.name = 'TelegramApiError';
  }
}

/**
 * Ein Button einer Inline-Tastatur: entweder Callback (`callback_data`, auf
 * 64 Byte begrenzt) oder externer Link (`url`) — Telegram verlangt genau
 * eines von beiden. Bewusst optionale Felder statt Union, damit Bestands-
 * Code (Tests) weiter direkt auf `callback_data` zugreifen kann.
 */
export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

export interface SendMessageOptions {
  chatId: string | number;
  text: string;
  keyboard?: InlineKeyboard | null;
  /** Standard ist HTML — nur setzen, um Parse-Mode ganz abzuschalten. */
  parseMode?: 'HTML' | null;
  /**
   * Stille Zustellung: die Nachricht erscheint im Chat, aber ohne Ton und
   * Vibration (`disable_notification`). Für Anlässe, die informieren sollen,
   * ohne zu unterbrechen.
   */
  silent?: boolean;
  /**
   * Nachrichten-Effekt (`message_effect_id`, Bot API 7.4) — nur in privaten
   * Chats; Gruppen lehnen ihn ab. Der Handball-Bot schickt 🎉 zum Sieg.
   */
  messageEffectId?: string;
}

/** Telegram-Update, soweit der Bot es auswertet. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  /** Der Bot wurde in einen Chat aufgenommen oder daraus entfernt (Gruppen). */
  my_chat_member?: TelegramChatMemberUpdated;
  /** Jemand tippt `@bot …` in ein beliebiges Nachrichtenfeld (Inline-Modus, nur der Handball-Bot). */
  inline_query?: TelegramInlineQuery;
}

export interface TelegramInlineQuery {
  id: string;
  from: TelegramUser;
  query: string;
  offset?: string;
  /** sender · private · group · supergroup · channel — fehlt bei geheimen Chats. */
  chat_type?: string;
}

export interface TelegramChatMemberUpdated {
  chat: { id: number; type: string; title?: string };
  from?: TelegramUser;
  new_chat_member: { status: string; user?: TelegramUser };
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  /** `type`: private · group · supergroup · channel; `title` nur bei Gruppen. */
  chat: { id: number; type: string; title?: string };
  date?: number;
  text?: string;
  /** Bildunterschrift — manche Apps schicken beim Teilen den Text hier. */
  caption?: string;
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  audio?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  photo?: Array<{ file_id: string }>;
  document?: { file_id: string; mime_type?: string };
  sticker?: unknown;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Escapet die drei Zeichen, die Telegrams HTML-Parse-Mode auszeichnet.
 * Auf jeden Freitext anwenden, der in eine Antwort eingebettet wird —
 * Aufgabentitel und Transkripte sind Nutzereingaben.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Ein Datei-Upload an Telegram: Feldname (`photo`, `document`), Dateiname,
 * Typ und die Bytes. Geht als multipart/form-data raus, weil Telegram bei
 * einer URL das Bild selbst holen müsste — und eine URL, die Telegram lesen
 * kann, wäre eine ohne Anmeldung. Die Bytes bleiben so hinter dem Login.
 */
export interface TelegramUpload {
  /** `file0` … `file9`: Teile eines Albums, im `media`-Feld per `attach://fileN` genannt. */
  field: 'photo' | 'document' | 'animation' | `file${number}`;
  filename: string;
  contentType: string;
  data: Buffer;
}

/** Ein einzelner API-Call ohne Retry — JSON, oder Multipart mit Datei. */
async function callOnce<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  upload?: TelegramUpload | TelegramUpload[],
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    let body: BodyInit;
    let headers: Record<string, string> | undefined;
    const uploads = Array.isArray(upload) ? upload : upload ? [upload] : [];
    if (uploads.length > 0) {
      // Telegram erwartet Nicht-Datei-Felder als Strings; Objekte
      // (reply_markup) als JSON-String.
      const form = new FormData();
      for (const [key, value] of Object.entries(payload)) {
        if (value === undefined || value === null) continue;
        form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      for (const u of uploads) {
        form.append(u.field, new Blob([new Uint8Array(u.data)], { type: u.contentType }), u.filename);
      }
      body = form;
    } else {
      body = JSON.stringify(payload);
      headers = { 'Content-Type': 'application/json' };
    }
    res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new TelegramApiError(method, null, `Zeitueberschreitung nach ${timeoutMs} ms`);
    }
    throw new TelegramApiError(method, null, err instanceof Error ? err.message : 'Netzwerkfehler');
  } finally {
    clearTimeout(timer);
  }

  const json = await res.json().catch(() => null) as TelegramResponse<T> | null;
  if (!res.ok || !json?.ok) {
    throw new TelegramApiError(
      method,
      res.status,
      json?.description ?? `HTTP ${res.status}`,
      json?.parameters?.retry_after ?? null,
    );
  }
  return json.result as T;
}

/**
 * Fuehrt einen API-Call aus und wiederholt transiente Fehler (429/5xx,
 * Timeout) bis zu zweimal mit Backoff. Bei 429 respektiert der Backoff
 * `retry_after`, gedeckelt auf 5 s — laenger blockiert die Queue unnoetig,
 * die Aktion selbst ist ja bereits ausgefuehrt.
 */
export async function callTelegram<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  opts: { timeoutMs?: number; upload?: TelegramUpload | TelegramUpload[] } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastErr: TelegramApiError = new TelegramApiError(method, null, 'Kein Versuch ausgefuehrt');
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await callOnce<T>(token, method, payload, timeoutMs, opts.upload);
    } catch (err) {
      if (!(err instanceof TelegramApiError)) throw err;
      const retryable = err.status === null || RETRYABLE_STATUS.has(err.status);
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw err;
      lastErr = err;
      const retryAfterMs = err.retryAfter ? Math.min(err.retryAfter * 1000, 5000) : 0;
      await sleep(Math.max(RETRY_DELAYS_MS[attempt], retryAfterMs));
    }
  }
  throw lastErr;
}

/** Antwortet im Chat. Text wird als HTML gerendert (siehe `escapeHtml`). */
export async function sendMessage(token: string, opts: SendMessageOptions): Promise<TelegramMessage> {
  const payload: Record<string, unknown> = {
    chat_id: opts.chatId,
    text: opts.text,
    disable_web_page_preview: true,
  };
  if (opts.parseMode !== null) payload.parse_mode = opts.parseMode ?? 'HTML';
  if (opts.keyboard) payload.reply_markup = opts.keyboard;
  if (opts.silent) payload.disable_notification = true;
  if (opts.messageEffectId) payload.message_effect_id = opts.messageEffectId;
  return callTelegram<TelegramMessage>(token, 'sendMessage', payload);
}

export interface SendPhotoOptions {
  chatId: string | number;
  /** HTTPS-Bild-URL — Telegram lädt das Bild selbst (max. 5 MB, JPEG/PNG). */
  photoUrl: string;
  /** Bildunterschrift, HTML-Parse-Mode wie bei sendMessage. Limit 1024. */
  caption: string;
  keyboard?: InlineKeyboard | null;
  /** Wie bei `sendMessage`: zustellen ohne Ton und Vibration. */
  silent?: boolean;
}

/**
 * Verschickt ein Foto mit Bildunterschrift — genutzt von den ADS-B-
 * Benachrichtigungen (Planespotters-Foto des Flugzeugs). Etwas großzügigerer
 * Timeout als sendMessage, weil Telegram das Bild erst von der URL abholt.
 * Schlägt der Abruf fehl (kaputte/zu große URL), antwortet Telegram mit 400 —
 * der Aufrufer fällt dann auf eine Textnachricht zurück.
 */
export async function sendPhoto(token: string, opts: SendPhotoOptions): Promise<TelegramMessage> {
  const payload: Record<string, unknown> = {
    chat_id: opts.chatId,
    photo: opts.photoUrl,
    // Telegram deckelt Captions bei 1024 Zeichen; unsere Texte sind weit
    // darunter, der Schnitt ist reine Absicherung.
    caption: opts.caption.slice(0, 1024),
    parse_mode: 'HTML',
  };
  if (opts.keyboard) payload.reply_markup = opts.keyboard;
  if (opts.silent) payload.disable_notification = true;
  return callTelegram<TelegramMessage>(token, 'sendPhoto', payload, { timeoutMs: 20_000 });
}

export interface SendUploadOptions {
  chatId: string | number;
  /** Die Datei selbst — Telegram bekommt die Bytes, keine URL. */
  data: Buffer;
  filename: string;
  contentType: string;
  /** Bildunterschrift, HTML wie bei sendMessage. Limit 1024. */
  caption: string;
  keyboard?: InlineKeyboard | null;
  silent?: boolean;
  /** Wie bei `sendMessage`: Nachrichten-Effekt, nur in privaten Chats. */
  messageEffectId?: string;
}

/** Telegram nimmt Fotos bis 10 MB, Dokumente bis 50 MB per Upload an. */
export const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const TELEGRAM_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;

function uploadPayload(opts: SendUploadOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    chat_id: opts.chatId,
    caption: opts.caption.slice(0, 1024),
    parse_mode: 'HTML',
  };
  if (opts.keyboard) payload.reply_markup = opts.keyboard;
  if (opts.silent) payload.disable_notification = true;
  if (opts.messageEffectId) payload.message_effect_id = opts.messageEffectId;
  return payload;
}

/**
 * Verschickt ein Foto aus dem Speicher — das Tageswetter als gerenderte
 * E-Ink-Anzeige. Längerer Timeout, weil die Bytes mit hochgehen.
 */
export async function sendPhotoBytes(token: string, opts: SendUploadOptions): Promise<TelegramMessage> {
  if (opts.data.length > TELEGRAM_PHOTO_MAX_BYTES) {
    throw new TelegramApiError('sendPhoto', 413, `Foto zu groß (${opts.data.length} Bytes)`);
  }
  return callTelegram<TelegramMessage>(token, 'sendPhoto', uploadPayload(opts), {
    timeoutMs: 30_000,
    upload: { field: 'photo', filename: opts.filename, contentType: opts.contentType, data: opts.data },
  });
}

/** Telegram nimmt Animationen (GIF, MP4 ohne Ton) bis 50 MB per Upload an. */
export const TELEGRAM_ANIMATION_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Verschickt eine Animation aus dem Speicher — der Endstand des
 * Handball-Bots als GIF mit hochzählenden Zahlen. Telegram wandelt ein GIF
 * in ein stummes MP4 um und spielt es im Chat von selbst ab.
 */
export async function sendAnimationBytes(token: string, opts: SendUploadOptions): Promise<TelegramMessage> {
  if (opts.data.length > TELEGRAM_ANIMATION_MAX_BYTES) {
    throw new TelegramApiError('sendAnimation', 413, `Animation zu groß (${opts.data.length} Bytes)`);
  }
  return callTelegram<TelegramMessage>(token, 'sendAnimation', uploadPayload(opts), {
    timeoutMs: 60_000,
    upload: { field: 'animation', filename: opts.filename, contentType: opts.contentType, data: opts.data },
  });
}

/** Ein Foto eines Albums; die Bildunterschrift trägt üblicherweise nur das erste. */
export interface MediaGroupPhoto {
  data: Buffer;
  filename: string;
  contentType: string;
  caption?: string;
}

/**
 * Zwei bis zehn Fotos als **ein** Album (`sendMediaGroup`) statt einzelner
 * Nachrichten. Die Bytes gehen als `file0` … `file9` im selben Multipart,
 * das `media`-Feld verweist per `attach://` darauf. Ein Album kann keine
 * Knöpfe tragen — wer welche braucht, schickt sie als Folgenachricht.
 */
export async function sendMediaGroupPhotos(token: string, chatId: string | number, photos: MediaGroupPhoto[], opts: { silent?: boolean } = {}): Promise<TelegramMessage[]> {
  if (photos.length < 2 || photos.length > 10) {
    throw new TelegramApiError('sendMediaGroup', 400, `Ein Album braucht 2 bis 10 Fotos, nicht ${photos.length}`);
  }
  const zuGross = photos.find(p => p.data.length > TELEGRAM_PHOTO_MAX_BYTES);
  if (zuGross) throw new TelegramApiError('sendMediaGroup', 413, `Foto zu groß (${zuGross.data.length} Bytes)`);
  const media = photos.map((p, i) => ({
    type: 'photo',
    media: `attach://file${i}`,
    ...(p.caption ? { caption: p.caption.slice(0, 1024), parse_mode: 'HTML' } : {}),
  }));
  const payload: Record<string, unknown> = { chat_id: chatId, media };
  if (opts.silent) payload.disable_notification = true;
  return callTelegram<TelegramMessage[]>(token, 'sendMediaGroup', payload, {
    timeoutMs: 60_000,
    upload: photos.map((p, i) => ({ field: `file${i}` as const, filename: p.filename, contentType: p.contentType, data: p.data })),
  });
}

/**
 * Verschickt ein Dokument aus dem Speicher — die Rundblick-Ausgabe als PDF
 * direkt in den Chat statt nur als Link auf die Aufgabe.
 */
export async function sendDocument(token: string, opts: SendUploadOptions): Promise<TelegramMessage> {
  if (opts.data.length > TELEGRAM_DOCUMENT_MAX_BYTES) {
    throw new TelegramApiError('sendDocument', 413, `Dokument zu groß (${opts.data.length} Bytes)`);
  }
  return callTelegram<TelegramMessage>(token, 'sendDocument', uploadPayload(opts), {
    timeoutMs: 60_000,
    upload: { field: 'document', filename: opts.filename, contentType: opts.contentType, data: opts.data },
  });
}

/**
 * Eine Emoji-Reaktion auf eine Nachricht im Chat (Bot API 7.0) — auf eine
 * eigene oder, im privaten Chat, auf die des Nutzers. Telegram nimmt nur
 * seine Standard-Reaktionen an (👍 👌 🔥 🎉 👏 🏆 …; ✅ gehört **nicht** dazu);
 * ein anderes Emoji ist ein 400, ebenso ein Chat, in dem Reaktionen
 * abgeschaltet sind. Aufrufer fangen: Wo die Reaktion eine Antwort ersetzt,
 * fällt der Aufrufer auf den Text zurück, statt still zu bleiben.
 */
export async function setMessageReaction(token: string, chatId: string | number, messageId: number, emoji: string): Promise<void> {
  await callTelegram(token, 'setMessageReaction', {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji }],
  });
}

/**
 * Heftet eine Nachricht oben im Chat an. `silent` unterdrückt die
 * Systemmeldung „… hat eine Nachricht angeheftet" als Benachrichtigung — wer
 * gerade selbst auf „Anheften" getippt hat, braucht keinen Hinweis darauf.
 */
export async function pinChatMessage(
  token: string,
  chatId: string | number,
  messageId: number,
  opts: { silent?: boolean } = {},
): Promise<void> {
  await callTelegram(token, 'pinChatMessage', {
    chat_id: chatId,
    message_id: messageId,
    ...(opts.silent ? { disable_notification: true } : {}),
  });
}

/** Löst genau diese angeheftete Nachricht — andere angeheftete bleiben. */
export async function unpinChatMessage(token: string, chatId: string | number, messageId: number): Promise<void> {
  await callTelegram(token, 'unpinChatMessage', { chat_id: chatId, message_id: messageId });
}

/**
 * Quittiert einen Button-Druck. Ohne diesen Call zeigt Telegram beim Nutzer
 * minutenlang einen Ladekreis auf dem Button.
 */
export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await callTelegram(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

/**
 * Entfernt die Inline-Tastatur einer bereits gesendeten Nachricht — damit ein
 * schon bestaetigter Entwurf nicht ein zweites Mal bestaetigt werden kann.
 * Fehler sind hier folgenlos (die Aktion ist gelaufen), der Aufrufer faengt.
 */
export async function clearInlineKeyboard(
  token: string,
  chatId: string | number,
  messageId: number,
): Promise<void> {
  await callTelegram(token, 'editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });
}

/**
 * Ersetzt Text und Tastatur einer bereits gesendeten Nachricht.
 *
 * Fuer Listen, die man mehrfach antippt (Einkaufsliste abhaken): eine neue
 * Nachricht je Haken wuerde den Chat fluten und die Liste nach unten schieben.
 * Telegram antwortet mit `400 message is not modified`, wenn sich nichts
 * aendert — das ist kein Fehler, sondern ein Doppelklick, und der Aufrufer
 * darf es ignorieren.
 */
export async function editMessageText(
  token: string,
  chatId: string | number,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard | null,
): Promise<void> {
  await callTelegram(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard ?? { inline_keyboard: [] },
  });
}

/**
 * Laedt eine Sprachnachricht herunter. Zweistufig, wie von Telegram
 * vorgegeben: `getFile` liefert den Pfad, der eigentliche Download laeuft
 * ueber `/file/bot<token>/<pfad>`. `maxBytes` deckelt, was in den Speicher
 * gezogen wird — das Audio wird ohnehin nie persistiert (§3.3).
 */
export async function downloadFile(
  token: string,
  fileId: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ buffer: Buffer; filePath: string }> {
  const maxBytes = opts.maxBytes ?? 20 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  const file = await callTelegram<{ file_path?: string; file_size?: number }>(
    token,
    'getFile',
    { file_id: fileId },
  );
  if (!file.file_path) {
    throw new TelegramApiError('getFile', null, 'Antwort ohne file_path');
  }
  if (typeof file.file_size === 'number' && file.file_size > maxBytes) {
    throw new TelegramApiError('getFile', null, `Datei zu gross (${file.file_size} Byte)`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/file/bot${token}/${file.file_path}`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new TelegramApiError('getFile', res.status, `Download fehlgeschlagen (HTTP ${res.status})`);
    }
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new TelegramApiError('getFile', null, `Datei zu gross (${arrayBuffer.byteLength} Byte)`);
    }
    return { buffer: Buffer.from(arrayBuffer), filePath: file.file_path };
  } catch (err) {
    if (err instanceof TelegramApiError) throw err;
    if (controller.signal.aborted) {
      throw new TelegramApiError('getFile', null, `Download-Zeitueberschreitung nach ${timeoutMs} ms`);
    }
    throw new TelegramApiError('getFile', null, err instanceof Error ? err.message : 'Netzwerkfehler');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Registriert den Webhook. `secretToken` landet bei jedem Update im Header
 * `X-Telegram-Bot-Api-Secret-Token` und ist die eigentliche Authentifizierung
 * des Endpoints (§3.2) — der Zufallspfad ist nur die zweite Schicht.
 *
 * `allowed_updates` haelt bewusst nur `message` und `callback_query`: alles
 * andere (edited_message, channel_post, …) wertet der Bot nicht aus und
 * muesste sonst pro Update verworfen werden. Der Handball-Bot übergibt eine
 * eigene Liste (Gruppen-Austritt, Inline-Modus); der Todoteck-Bot bleibt beim
 * Standard.
 */
export async function setWebhook(
  token: string,
  url: string,
  secretToken: string,
  allowedUpdates: string[] = ['message', 'callback_query'],
): Promise<void> {
  await callTelegram(token, 'setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: allowedUpdates,
    // Beim Neustart nach laengerem Ausfall keine Update-Lawine abarbeiten:
    // was der Nutzer vor Stunden geschickt hat, will er jetzt nicht mehr
    // ausgefuehrt bekommen.
    drop_pending_updates: true,
    max_connections: 10,
  });
}

/** Ein Eintrag im „/"-Menue des Telegram-Clients. */
export interface BotCommand {
  /** Ohne fuehrenden Slash, nur a-z, 0-9 und _ (Telegram-Vorgabe). */
  command: string;
  /** Maximal 256 Zeichen, wird unter dem Kommando angezeigt. */
  description: string;
}

/**
 * Fuellt das „/"-Menue des Clients. Ohne diesen Aufruf ist die Liste leer und
 * jedes Kommando muss auswendig getippt werden — `/hilfe` findet nur, wer
 * schon weiss, dass es sie gibt.
 *
 * `scope: default` gilt fuer alle Chats; der Bot hat ohnehin nur 1:1-Chats.
 * Die Sprache bleibt offen (kein `language_code`), damit die Liste unabhaengig
 * von der Client-Sprache erscheint — die Beschreibungen sind deutsch, weil es
 * die Oberflaeche auch ist.
 */
export async function setMyCommands(token: string, commands: BotCommand[], scope: BotCommandScope = { type: 'default' }): Promise<void> {
  await callTelegram(token, 'setMyCommands', {
    commands,
    scope,
  });
}

/**
 * Für wen eine Befehlsliste gilt. `chat` ersetzt für genau diesen Chat die
 * Standardliste — wer dort zusätzliche Befehle zeigen will, schickt die
 * Standardbefehle mit.
 */
export type BotCommandScope = { type: 'default' } | { type: 'chat'; chat_id: string | number };

/** Entfernt die Befehlsliste eines Geltungsbereichs; danach gilt dort wieder die Standardliste. */
export async function deleteMyCommands(token: string, scope: BotCommandScope): Promise<void> {
  await callTelegram(token, 'deleteMyCommands', { scope });
}

/** Was Telegram über den registrierten Webhook weiß (`getWebhookInfo`), soweit ausgewertet. */
export interface TelegramWebhookInfo {
  url: string;
  pending_update_count: number;
  /** Unix-Sekunden des letzten Zustellfehlers an den Webhook. */
  last_error_date?: number;
  last_error_message?: string;
}

/**
 * Den Webhook bei Telegram nachsehen — ob er noch auf diese Instanz zeigt.
 * Ein Versuch mit kurzem Timeout, kein Wiederholen: Der Aufrufer sitzt
 * womöglich in einer Anfrage und nimmt einen Fehlschlag als „unbekannt".
 */
export async function getWebhookInfo(token: string, timeoutMs = 4_000): Promise<TelegramWebhookInfo> {
  return callOnce<TelegramWebhookInfo>(token, 'getWebhookInfo', {}, timeoutMs);
}

/** Bot-Stammdaten (Username fuers `t.me/<bot>?start=`-Deep-Link). */
export async function getMe(token: string): Promise<{ id: number; username?: string; first_name?: string; supports_inline_queries?: boolean }> {
  return callTelegram(token, 'getMe', {});
}

/**
 * „schickt ein Foto …" oben im Chat, während ein Bild gerendert wird. Hält
 * fünf Sekunden oder bis zur nächsten Nachricht des Bots. Beiwerk: Aufrufer
 * warten nicht darauf und fangen jeden Fehler.
 */
export type ChatAction = 'typing' | 'upload_photo' | 'upload_video' | 'upload_document' | 'find_location';

export async function sendChatAction(token: string, chatId: string | number, action: ChatAction): Promise<void> {
  // Kurzer Timeout und kein zweiter Versuch: Eine Anzeige, die nach dem Bild kommt, ist wertlos.
  await callOnce(token, 'sendChatAction', { chat_id: chatId, action }, 3_000);
}

export interface SendVenueOptions {
  chatId: string | number;
  latitude: number;
  longitude: number;
  /** Name des Ortes — bei Telegram Pflicht. */
  title: string;
  /** Anschrift — bei Telegram Pflicht. */
  address: string;
  keyboard?: InlineKeyboard | null;
  silent?: boolean;
}

/** Ein Ort als Karte im Chat — antippen öffnet die Karten-App des Telefons. */
export async function sendVenue(token: string, opts: SendVenueOptions): Promise<TelegramMessage> {
  const payload: Record<string, unknown> = {
    chat_id: opts.chatId,
    latitude: opts.latitude,
    longitude: opts.longitude,
    title: opts.title.slice(0, 256),
    address: opts.address.slice(0, 256),
  };
  if (opts.keyboard) payload.reply_markup = opts.keyboard;
  if (opts.silent) payload.disable_notification = true;
  return callTelegram<TelegramMessage>(token, 'sendVenue', payload);
}

/** Ein Ergebnis im Inline-Modus: ein Bild, das Telegram selbst von der URL holt (JPEG). */
export interface InlineQueryResultPhoto {
  type: 'photo';
  id: string;
  photo_url: string;
  thumbnail_url: string;
  title?: string;
  description?: string;
  caption?: string;
  parse_mode?: 'HTML';
}

export interface AnswerInlineQueryOptions {
  /** Wie lange Telegram die Antwort zwischenspeichert, in Sekunden. */
  cacheTime?: number;
  /** Zwischenspeicher je Nutzer statt je Suchtext. */
  isPersonal?: boolean;
  /** Knopf über den Ergebnissen — hier: „Bot starten" für Fremde. */
  button?: { text: string; start_parameter: string };
}

export async function answerInlineQuery(token: string, inlineQueryId: string, results: InlineQueryResultPhoto[], opts: AnswerInlineQueryOptions = {}): Promise<void> {
  const payload: Record<string, unknown> = { inline_query_id: inlineQueryId, results };
  if (opts.cacheTime !== undefined) payload.cache_time = opts.cacheTime;
  if (opts.isPersonal !== undefined) payload.is_personal = opts.isPersonal;
  if (opts.button) payload.button = opts.button;
  await callTelegram(token, 'answerInlineQuery', payload);
}

/** Telegrams Obergrenzen für die beiden Beschreibungstexte des Bots. */
export const BOT_SHORT_DESCRIPTION_MAX = 120;
export const BOT_DESCRIPTION_MAX = 512;

/** Der Satz im Profil und beim Teilen des Bots (höchstens 120 Zeichen). */
export async function setMyShortDescription(token: string, text: string): Promise<void> {
  await callTelegram(token, 'setMyShortDescription', { short_description: text.slice(0, BOT_SHORT_DESCRIPTION_MAX) });
}

/** Der Text im leeren Chat unter „Was kann dieser Bot?" (höchstens 512 Zeichen). */
export async function setMyDescription(token: string, text: string): Promise<void> {
  await callTelegram(token, 'setMyDescription', { description: text.slice(0, BOT_DESCRIPTION_MAX) });
}
