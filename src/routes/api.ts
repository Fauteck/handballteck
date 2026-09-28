/**
 * Die API für das Todoteck-Cockpit (`/api/*`, Bearer `API_TOKEN`): dieselben
 * Antworten, die Todotecks `routes/handball.ts` bis zum 28.09.2026 selbst aus
 * seiner Datenbank baute — Übersicht, Details, Bilder, ein erzwungener Lauf
 * und die Gesundheit für die Dienste-Zeile. Todoteck reicht sie eins zu eins
 * an sein Frontend durch; die Form ist deshalb ein Vertrag mit
 * `apps/web/src/hooks/useHandball.ts` dort.
 *
 * Ohne `API_TOKEN` antwortet alles 401: Ein Dienst, dessen interne Sicht
 * offen im Netz steht, ist ein offener Bild-Generator.
 */

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { apiToken, version, teamIds } from '../config';
import { handballOverview, syncHandballTeams, playerStats, playerGames, getHandballHealth, type HandballTeamView } from '../lib/handballTeam';
import {
  getHandballBotUsername, isHandballBotEnabled, listSubscribers, pushHandballBot, getHandballBotHealth, refreshHandballWebhookInfo,
  bildTabelle, bildKader, bildSpiel, bildVerlauf, bildTorjaeger, bildSpieler, bildSaison, endstandBild,
  textSaison, textRekorde, alsKlartext, pflegeHandballBotBeschreibung,
} from '../lib/handballBot';
import { renderPng } from '../lib/handballTableImage';
import { siteConfig } from '../lib/handballSite';
import { pushHandballSite, countSiteSubscribers, sitePushConfig } from '../lib/handballSitePush';
import { getBackoffSnapshot } from '../lib/pollerBackoff';

function tokenPasst(request: FastifyRequest): boolean {
  const soll = apiToken();
  if (!soll) return false;
  const kopf = request.headers.authorization;
  const ist = typeof kopf === 'string' && kopf.startsWith('Bearer ') ? kopf.slice(7).trim() : '';
  const a = Buffer.from(ist, 'utf8');
  const b = Buffer.from(soll, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function apiRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!tokenPasst(request)) {
      return reply.code(401).header('Cache-Control', 'no-store').send({ error: 'unauthorized', message: apiToken() ? 'Token fehlt oder passt nicht.' : 'API_TOKEN ist auf dem Handball-Dienst nicht gesetzt.' });
    }
  });

  /** Gesundheit für die Dienste-Zeile in Todoteck — Abruf, Bot, Microsite in einer Antwort. */
  fastify.get('/api/health', async (_request, reply) => {
    await refreshHandballWebhookInfo();
    const snapshot = getBackoffSnapshot('handball', 'team');
    const bot = getHandballBotHealth();
    const sicht = handballOverview();
    const push = sitePushConfig();
    return reply.header('Cache-Control', 'no-store').send({
      ok: true,
      version: version(),
      teams: teamIds().length,
      updated_at: sicht.updated_at,
      sync: {
        last_error: getHandballHealth().lastError,
        last_success_at: snapshot?.lastSuccessAt ? new Date(snapshot.lastSuccessAt).toISOString() : null,
        consecutive_failures: snapshot?.consecutiveFailures ?? 0,
        backoff_until: snapshot?.nextAllowedAt && snapshot.nextAllowedAt > Date.now() ? new Date(snapshot.nextAllowedAt).toISOString() : null,
      },
      bot: {
        enabled: isHandballBotEnabled(),
        username: getHandballBotUsername(),
        subscribers: isHandballBotEnabled() ? listSubscribers().length : 0,
        configured: bot.configured,
        error: bot.error,
        failed_7d: bot.failed7d,
        delivered_7d: bot.delivered7d,
        last_ok: bot.lastOk,
        detail: bot.detail,
      },
      site: {
        enabled: sicht.configured && sicht.teams.length > 0 ? siteConfig(sicht.teams[0].team_id).enabled : false,
        push: push.enabled,
        subscribers: countSiteSubscribers(),
      },
    });
  });

  /** Spielplan, nächstes Spiel, Tabelle je eingetragener Mannschaft — nur aus der Datenbank. */
  fastify.get('/api/overview', async (_request, reply) => {
    const bot = isHandballBotEnabled()
      ? { enabled: true, username: getHandballBotUsername(), subscribers: listSubscribers().length }
      : { enabled: false, username: null, subscribers: 0 };
    const sicht = handballOverview();
    const site = sicht.teams.map(t => {
      const cfg = siteConfig(t.team_id);
      return { team_id: t.team_id, enabled: cfg.enabled, url: cfg.baseUrl, players: cfg.players, subscribers: countSiteSubscribers(t.team_id) };
    });
    return reply.header('Cache-Control', 'no-store').send({ ...sicht, bot, site });
  });

  /** Ein erzwungener Lauf — Tageslauf plus Nachfassen, danach die Meldungen an Bot und Microsite. */
  fastify.post('/api/sync', async (_request, reply) => {
    const r = await syncHandballTeams(true);
    if (r.status === 'not_configured') {
      return reply.code(503).send({ error: 'disabled', message: 'Keine Mannschaft eingetragen — TEAM_IDS auf dem Handball-Dienst setzen.' });
    }
    const bot = r.status === 'ok' ? await pushHandballBot() : null;
    const site = r.status === 'ok' ? await pushHandballSite() : null;
    if (r.status === 'ok') { try { await pflegeHandballBotBeschreibung(); } catch { /* Beiwerk */ } }
    return reply.send({ ...r, bot, site });
  });

  function mannschaft(teamId: string): HandballTeamView | null {
    const sicht = handballOverview();
    return sicht.configured ? sicht.teams.find(t => t.team_id === teamId) ?? null : null;
  }

  async function bildAntwort(reply: FastifyReply, svg: string | null, fehlt: string) {
    if (!svg) return reply.code(404).send({ error: 'no_image', message: fehlt });
    const png = await renderPng(svg);
    return reply.header('Content-Type', 'image/png').header('Cache-Control', 'private, max-age=300').send(png);
  }

  /** Die Bilder des Bots für das Cockpit: dieselben Funktionen, dieselben PNGs, gerendert je Aufruf. */
  fastify.get<{ Params: { teamId: string; art: string }; Querystring: { match?: string } }>('/api/teams/:teamId/bild/:art', async (request, reply) => {
    const team = mannschaft(request.params.teamId);
    if (!team) return reply.code(404).send({ error: 'not_found', message: 'Diese Mannschaft ist nicht eingetragen.' });
    switch (request.params.art) {
      case 'tabelle': {
        const s = team.standings[0];
        return bildAntwort(reply, s && s.rows.length > 0 ? bildTabelle(team, s) : null, 'Noch keine Tabelle geholt.');
      }
      case 'kader':
        return bildAntwort(reply, bildKader(team), 'Noch kein Kader geholt — er kommt mit dem nächsten Tageslauf.');
      case 'spiel':
        return bildAntwort(reply, team.next_match && team.next_match.status !== 'live' ? await bildSpiel(team.next_match) : null, 'Kein weiteres Spiel angesetzt.');
      case 'endstand': {
        const wunsch = request.query.match;
        const m = wunsch
          ? team.matches.find(x => x.match_id === wunsch && (x.status === 'finished' || x.rated)) ?? null
          : team.last_match;
        if (!m || m.score_home === null || m.score_away === null) return bildAntwort(reply, null, 'Noch kein Endstand in dieser Saison.');
        const bester = playerGames(team.team_id).filter(g => g.matchId === m.match_id).sort((a, b) => b.goals - a.goals)[0];
        return bildAntwort(reply, await endstandBild(team, m, {
          playerOfMatch: bester && bester.goals > 0 ? `${bester.name} · ${bester.goals} Tor${bester.goals === 1 ? '' : 'e'}` : null,
        }), 'Noch kein Endstand.');
      }
      case 'verlauf':
        return bildAntwort(reply, bildVerlauf(team), 'Der Verlauf braucht zwei gespielte Spieltage.');
      case 'torjaeger':
        return bildAntwort(reply, bildTorjaeger(team), 'Noch kein Tor gespeichert — die Aufstellungen kommen mit dem nächsten Lauf.');
      case 'saison':
        return bildAntwort(reply, bildSaison(team), 'Die Saisonkarte braucht ein gespieltes Spiel.');
      default:
        return reply.code(404).send({ error: 'not_found', message: 'Dieses Bild gibt es nicht.' });
    }
  });

  /** Die Tore je Spiel eines Spielers — 404 unter zwei Spielen. */
  fastify.get<{ Params: { teamId: string; playerId: string } }>('/api/teams/:teamId/bild/spieler/:playerId', async (request, reply) => {
    const team = mannschaft(request.params.teamId);
    if (!team) return reply.code(404).send({ error: 'not_found', message: 'Diese Mannschaft ist nicht eingetragen.' });
    const p = playerStats(team.team_id).find(x => x.playerId === request.params.playerId);
    if (!p) return reply.code(404).send({ error: 'not_found', message: 'Zu diesem Spieler ist keine Aufstellung gespeichert.' });
    return bildAntwort(reply, bildSpieler(team, p), 'Die Grafik braucht zwei Spiele mit Aufstellung.');
  });

  /** Was das Cockpit neben den Bildern zeigt: Saisonbilanz und Rekorde als Zeilen, die Spieler, und welche Bilder es gibt. */
  fastify.get<{ Params: { teamId: string } }>('/api/teams/:teamId/details', async (request, reply) => {
    const team = mannschaft(request.params.teamId);
    if (!team) return reply.code(404).send({ error: 'not_found', message: 'Diese Mannschaft ist nicht eingetragen.' });
    const stats = playerStats(team.team_id);
    const spiele = new Map<string, number>();
    for (const g of playerGames(team.team_id)) spiele.set(g.playerId, (spiele.get(g.playerId) ?? 0) + 1);
    return reply.send({
      saison: alsKlartext(textSaison(team)),
      rekorde: alsKlartext(textRekorde(team, playerGames(team.team_id))),
      spieler: stats.filter(p => p.games > 0).sort((a, b) => a.number - b.number)
        .map(p => ({ player_id: p.playerId, name: p.name, number: p.number, goals: p.goals, games: p.games, chart: (spiele.get(p.playerId) ?? 0) >= 2 })),
      bilder: {
        tabelle: (team.standings[0]?.rows.length ?? 0) > 0,
        kader: bildKader(team) !== null,
        spiel: !!team.next_match && team.next_match.status !== 'live',
        endstand: !!team.last_match && team.last_match.score_home !== null,
        verlauf: bildVerlauf(team) !== null,
        torjaeger: stats.some(p => p.goals > 0),
        saison: team.matches.some(m => (m.status === 'finished' || m.rated) && m.score_home !== null),
      },
    });
  });
}
