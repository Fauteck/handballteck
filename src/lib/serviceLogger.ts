/**
 * Strukturierter Logger fuer Services ohne Request-Kontext (z. B. die
 * KI-Anreicherung, die fire-and-forget aus createTask laeuft). Beim Boot
 * verdrahtet `index.ts` den Fastify/Pino-Logger via `setServiceLogger` —
 * damit greifen Log-Level (`LOG_LEVEL`) und Redaction auch hier. Vor der
 * Verdrahtung (Tests, Migrations-Skripte) faellt er auf die Konsole zurueck.
 */

type LogFn = (obj: Record<string, unknown> | string, msg?: string) => void;

export interface ServiceLogger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

const consoleFallback: ServiceLogger = {
  // eslint-disable-next-line no-console
  info: (obj, msg) => console.info(msg ?? obj, msg ? obj : ''),
  // eslint-disable-next-line no-console
  warn: (obj, msg) => console.warn(msg ?? obj, msg ? obj : ''),
  // eslint-disable-next-line no-console
  error: (obj, msg) => console.error(msg ?? obj, msg ? obj : ''),
};

let current: ServiceLogger = consoleFallback;

export function setServiceLogger(logger: ServiceLogger): void {
  current = logger;
}

/** Stabiler Verweis — Aufrufer importieren `serviceLog`, nie die Variable. */
export const serviceLog: ServiceLogger = {
  info: (obj, msg) => current.info(obj, msg),
  warn: (obj, msg) => current.warn(obj, msg),
  error: (obj, msg) => current.error(obj, msg),
};
