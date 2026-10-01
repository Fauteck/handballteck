/**
 * VAPID-Konfiguration und der Versand ans Push-Gateway — übernommen aus
 * Todoteck (`lib/webPush.ts`), ohne die Knöpfe und Tickets der App.
 *
 * Push konfiguriert sich selbst: Das Schlüsselpaar wird beim ersten Bedarf
 * erzeugt und in `settings` abgelegt. Gesetzte `VAPID_PUBLIC_KEY`/
 * `VAPID_PRIVATE_KEY` gewinnen und werden in die Datenbank gespiegelt. Bei
 * einem Umzug aus Todoteck übernimmt `scripts/import-todoteck.ts` das Paar
 * von dort — sonst wären alle Browser-Anmeldungen der Microsite auf einen
 * Schlag ungültig (der Push-Dienst antwortet dann 403).
 */
import webpush from 'web-push';
import { getSetting, setSetting } from './settings';
import { serviceLog } from './serviceLogger';
import { publicUrl } from '../config';
import { isPushServiceUrl } from './ssrf';

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body?: string | null;
  /** Ziel beim Antippen der Systembenachrichtigung (relativ oder absolut). */
  url?: string;
  /** Ersetzt eine gleich getaggte Benachrichtigung, statt zu stapeln. */
  tag?: string;
  /** Großes Benachrichtigungsbild, sofern der Browser es zeigt. */
  image?: string;
  /** Vibrationsmuster in Millisekunden (Ton, Pause, Ton …), sofern das Gerät es kann. */
  vibrate?: number[];
}

export type PushResult =
  | { status: 'sent' }
  | { status: 'gone'; reason: string }
  | { status: 'retry'; reason: string };

export const SETTING_PUBLIC_KEY = 'vapid_public_key';
export const SETTING_PRIVATE_KEY = 'vapid_private_key';

let configured: boolean | null = null;
let activePublicKey: string | null = null;

function resolveSubject(): string {
  const fromEnv = process.env.VAPID_SUBJECT;
  if (fromEnv) return fromEnv;
  const url = publicUrl();
  if (url.startsWith('https://')) return url;
  return 'mailto:admin@localhost';
}

function resolveKeys(): { publicKey: string; privateKey: string } | null {
  const envPublic = process.env.VAPID_PUBLIC_KEY;
  const envPrivate = process.env.VAPID_PRIVATE_KEY;
  if (envPublic && envPrivate) {
    try {
      if (getSetting(SETTING_PUBLIC_KEY) !== envPublic) {
        setSetting(SETTING_PUBLIC_KEY, envPublic);
        setSetting(SETTING_PRIVATE_KEY, envPrivate);
      }
    } catch (err) {
      serviceLog.error({ err }, '[push] VAPID-Schlüssel aus der ENV konnten nicht gespiegelt werden');
    }
    return { publicKey: envPublic, privateKey: envPrivate };
  }
  try {
    const storedPublic = getSetting(SETTING_PUBLIC_KEY);
    const storedPrivate = getSetting(SETTING_PRIVATE_KEY);
    if (storedPublic && storedPrivate) return { publicKey: storedPublic, privateKey: storedPrivate };
    const generated = webpush.generateVAPIDKeys();
    setSetting(SETTING_PUBLIC_KEY, generated.publicKey);
    setSetting(SETTING_PRIVATE_KEY, generated.privateKey);
    serviceLog.info('[push] VAPID-Schlüsselpaar erzeugt und abgelegt.');
    return { publicKey: generated.publicKey, privateKey: generated.privateKey };
  } catch (err) {
    serviceLog.error({ err }, '[push] VAPID-Schlüssel konnten weder geladen noch erzeugt werden, Push bleibt inaktiv');
    return null;
  }
}

export function isPushConfigured(): boolean {
  if (configured !== null) return configured;
  const keys = resolveKeys();
  if (!keys) { configured = false; return configured; }
  try {
    webpush.setVapidDetails(resolveSubject(), keys.publicKey, keys.privateKey);
    activePublicKey = keys.publicKey;
    configured = true;
  } catch (err) {
    serviceLog.error({ err }, '[push] VAPID-Konfiguration ungültig, Push bleibt inaktiv');
    configured = false;
  }
  return configured;
}

export function getVapidPublicKey(): string | null {
  return isPushConfigured() ? activePublicKey : null;
}

/** Nur für Tests. */
export function resetPushConfigCache(): void {
  configured = null;
  activePublicKey = null;
}

/** Wirft nicht — der Aufrufer arbeitet eine Liste ab und darf nicht am ersten toten Gerät hängenbleiben. */
export async function sendPush(target: PushTarget, payload: PushPayload): Promise<PushResult> {
  if (!isPushConfigured()) return { status: 'retry', reason: 'VAPID nicht konfiguriert' };
  // SEC-1-001: Auch Zeilen, die vor der Prüfung in der Anmeldung (oder per
  // Import aus Todoteck) hereinkamen, gehen nur an einen Push-Dienst; alle
  // anderen gelten als tot und werden vom Aufrufer gelöscht.
  if (!isPushServiceUrl(target.endpoint)) return { status: 'gone', reason: 'kein bekannter Push-Dienst' };
  try {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload),
      { TTL: 60 * 60 },
    );
    return { status: 'sent' };
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode === 404 || statusCode === 410 || statusCode === 403) {
      return { status: 'gone', reason: `HTTP ${statusCode}` };
    }
    return { status: 'retry', reason: statusCode ? `HTTP ${statusCode}` : String(err) };
  }
}
