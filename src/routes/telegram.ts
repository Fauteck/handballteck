/**
 * Der Webhook des Telegram-Bots und die Bilder des Inline-Modus — beides
 * öffentlich, beides mit eigener Zugangskontrolle.
 *
 * Der Webhook nach dem Muster des Todoteck-Bots: Zufallspfad plus
 * Header-Geheimnis, beide zeitkonstant verglichen, Antwort immer sofort 200,
 * Verarbeitung danach (ein 5xx ließe Telegram endlos wiederholen). Die
 * Inline-Bilder holt Telegram selbst, ohne Anmeldung und nur als JPEG;
 * deshalb trägt jede URL eine eigene Signatur mit Ablauf (`inlineBildUrl`).
 */

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { handballOverview } from '../lib/handballTeam';
import { ensureHandballBotSecrets, handleHandballUpdate, isHandballBotEnabled, pruefeInlineSignatur, inlineBildSvg, type InlineArt } from '../lib/handballBot';
import { renderJpeg } from '../lib/handballTableImage';
import { serviceLog } from '../lib/serviceLogger';
import type { TelegramUpdate } from '../lib/telegramClient';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export async function telegramRoutes(fastify: FastifyInstance) {
  /**
   * Die Bilder des Inline-Modus: Zugang hat, wer eine gültige Signatur hat —
   * HMAC über Art, Mannschaft und Ablauf (24 Stunden), ausgestellt nur in
   * Antworten an Abonnenten. Ohne Bot-Token, ohne oder mit abgelaufener
   * Signatur: 403, ohne zu unterscheiden.
   */
  fastify.get<{ Params: { datei: string }; Querystring: { team?: string; exp?: string; t?: string; vorschau?: string } }>('/inline/:datei', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const treffer = /^([a-z]+)\.jpg$/.exec(request.params.datei);
    const art = treffer?.[1] ?? '';
    const { team: teamId = '', exp = '', t = '' } = request.query;
    if (!isHandballBotEnabled() || !pruefeInlineSignatur(art, teamId, exp, t)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const sicht = handballOverview();
    const team = sicht.configured ? sicht.teams.find(x => x.team_id === teamId) ?? null : null;
    const svg = team ? await inlineBildSvg(team, art as InlineArt) : null;
    if (!svg) return reply.code(404).send({ error: 'no_image', message: 'Dafür gibt es gerade kein Bild.' });
    const jpg = await renderJpeg(svg, request.query.vorschau === '1' ? 0.4 : 2);
    return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=300').send(jpg);
  });

  // Der Webhook steht immer, auch ohne Token — ohne Token antwortet die Route
  // wie bei falschem Geheimnis; es gibt nichts zu unterscheiden.
  const secrets = ensureHandballBotSecrets();

  fastify.post('/telegram/webhook/:secretPath', {
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!isHandballBotEnabled()) return reply.code(403).send({ error: 'Forbidden' });
    const { secretPath } = request.params as { secretPath: string };
    const headerSecret = request.headers['x-telegram-bot-api-secret-token'];
    if (
      typeof headerSecret !== 'string'
      || !safeEqual(headerSecret, secrets.webhookHeaderSecret)
      || !safeEqual(secretPath, secrets.webhookPathSecret)
    ) {
      serviceLog.warn({ ip: request.ip }, '[bot] Webhook-Request abgewiesen');
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const body = request.body as TelegramUpdate | undefined;
    if (body && typeof body.update_id === 'number') {
      void handleHandballUpdate(body);
    }
    return reply.code(200).send({ ok: true });
  });
}
