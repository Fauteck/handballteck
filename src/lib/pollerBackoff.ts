/**
 * Gemeinsamer In-Memory-Backoff/Circuit-Breaker für externe Poller (HA-Müll,
 * HA-Snapshot, …). Zuvor implementierte jeder Poller denselben Zustand
 * (`consecutiveFailures`/`nextAllowedAt`/`lastSuccessAt`) samt Konstanten und
 * Log-Schwelle byte-nah dupliziert. Diese Klasse zentralisiert die Zustands-
 * maschine; poller-spezifisches (Fehler-Klassifikation, Log-Text, Persistenz)
 * bleibt beim jeweiligen Poller.
 *
 * Zweck: ein down-Endpoint soll pro Schlüssel (i. d. R. User) Zyklen
 * überspringen (kein Hämmern) und Logs drosseln (WARN bis zur Schwelle, danach
 * ERROR), statt jeden Tick eine aussichtslose Anfrage + identische Fehlerzeile
 * zu produzieren.
 */

export const AUTH_BACKOFF_MS = 30 * 60 * 1000;
export const TRANSIENT_BACKOFF_MS = 10 * 60 * 1000;
export const DEFAULT_LOG_THRESHOLD = 3;

interface BackoffState {
  consecutiveFailures: number;
  nextAllowedAt: number | null;
  lastSuccessAt: number | null;
}

export interface BackoffSnapshot {
  consecutiveFailures: number;
  nextAllowedAt: number | null;
  lastSuccessAt: number | null;
}

/**
 * Registry benannter Backoff-Instanzen. Zweck: die Integrations-Gesundheits-
 * Route (`GET /sync/health`) kann Fehler-Serie und Backoff-Fenster der Poller
 * abfragen, ohne dass jedes Sync-Modul eine eigene Getter-Funktion exportieren
 * muss — der Zustand lebt ohnehin nur hier im Prozess.
 */
const registry = new Map<string, KeyedBackoff>();

export function getBackoffSnapshot(name: string, key: string): BackoffSnapshot | null {
  return registry.get(name)?.snapshot(key) ?? null;
}

export class KeyedBackoff {
  private readonly states = new Map<string, BackoffState>();

  constructor(
    private readonly logThreshold: number = DEFAULT_LOG_THRESHOLD,
    registryName?: string,
  ) {
    if (registryName) registry.set(registryName, this);
  }

  /** Momentaufnahme für Status-Anzeigen — `null`, wenn der Key nie lief. */
  snapshot(key: string): BackoffSnapshot | null {
    const s = this.states.get(key);
    return s ? { ...s } : null;
  }

  private stateFor(key: string): BackoffState {
    let s = this.states.get(key);
    if (!s) {
      s = { consecutiveFailures: 0, nextAllowedAt: null, lastSuccessAt: null };
      this.states.set(key, s);
    }
    return s;
  }

  /** > 0 ⇒ noch im Backoff-Fenster: der Caller soll diesen Zyklus überspringen. */
  remainingBackoffMs(key: string, now: number = Date.now()): number {
    const s = this.stateFor(key);
    if (s.nextAllowedAt === null || now >= s.nextAllowedAt) return 0;
    return s.nextAllowedAt - now;
  }

  /** Erfolg: Fehlerzähler und Backoff-Fenster zurücksetzen. */
  recordSuccess(key: string, now: number = Date.now()): void {
    const s = this.stateFor(key);
    s.consecutiveFailures = 0;
    s.nextAllowedAt = null;
    s.lastSuccessAt = now;
  }

  /**
   * Fehler registrieren: Fehlerzähler erhöhen und das Backoff-Fenster auf
   * `now + backoffMs` setzen (`backoffMs = 0` ⇒ zählen, aber nicht aussperren —
   * z. B. für Konfigurationsfehler, die kein Endpunkt-Problem sind). Liefert
   * den neuen Zählerstand und ob die Log-Schwelle erreicht ist (WARN → ERROR).
   */
  recordFailure(
    key: string,
    backoffMs: number,
    now: number = Date.now(),
  ): { consecutiveFailures: number; logAsError: boolean } {
    const s = this.stateFor(key);
    s.consecutiveFailures++;
    s.nextAllowedAt = now + backoffMs;
    return {
      consecutiveFailures: s.consecutiveFailures,
      logAsError: s.consecutiveFailures >= this.logThreshold,
    };
  }

  /** Test-Hook: gesamten Zustand löschen. */
  reset(): void {
    this.states.clear();
  }
}
