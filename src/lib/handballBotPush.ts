/**
 * Die Meldungen des Bots von sich aus: Ankündigung, Aufstellung, Halbzeit,
 * Endstand, Bericht, Verlegung und Saisonbilanz — je Lauf des Takts einmal
 * geprüft und an die Abonnenten verteilt. Aus `handballBot.ts` gelöst
 * (ARC-3-001); Zustellung und Protokoll bleiben dort, weil auch `/rundruf`
 * sie braucht.
 */

import { type HandballBotDeps, DEFAULT_DEPS, protokollAufraeumen, schonGeschickt, merke, rundsenden, fuerTeam, ALLE, ankuendigungFaelligAb, protokolliere, zustellungGescheitert, NUR_ALLES, halbzeitTastatur, KONFETTI_EFFECT_ID, rundsendenBild, anAlle, mitEffekt } from './handballBot';
import { isHandballBotEnabled, listSubscribers, CHANGE_MAX_AGE_MS, verfolgt, GRUSS_ABSTAND_ZUR_ANKUENDIGUNG_MS, LINEUP_FROM_MS, LINEUP_UNTIL_MS, HALFTIME_FROM_MS, HALFTIME_UNTIL_MS, RATED_MAX_AGE_MS, RESULT_MAX_AGE_MS, REPORT_UNTIL_MS, REPORT_FROM_MS } from './handballBotBasis';
import { handballOverview, aktuellesSpiel } from './handballSicht';
import { changesFor, opponentFormFor, merkeAnwurfSchaetzung, setzeHalbzeit, playerStats, storeLineup, setzeBericht, saisonVorbei } from './handballTeam';
import { textAenderung, routenTastatur, gegnerId, textAnkuendigung, ankuendigungTastatur, halleAlsOrt, spieltagsGrussFaellig, textSpieltag, eigeneSeite, textAufstellung, textHalbzeit, textEndstand, endstandTastatur, namenAus, tabellenBewegung, textBericht, berichtTastatur, textSaison } from './handballBotTexts';
import { type HandballMatch, fetchTeamMatches, fetchLineups, fetchMatchEvents, type HandballLineupSide, fetchMatchReport } from './handballNetClient';
import { serviceLog } from './serviceLogger';
import { type EndstandKarteExtras, endstandBild, endstandAnimation, bildSaison } from './handballBotImages';
import { svgAlsPng } from './bildCache';

export interface HandballBotPushResult {
  messages: number;
  recipients: number;
  /** Aufrufe nach handball.net aus dem Bot heraus: Aufstellung, Torfolge, Spielbericht, Gegner-Spielplan. */
  fetches: number;
}

/**
 * Die fälligen Meldungen — ein Takt des Jobs, **nach** dem Abruf. Liest die
 * Sicht aus der Datenbank; nach draußen geht nur der Aufstellungs-Abruf im
 * engen Fenster um den Anwurf und einmal für die Torschützen nach dem Spiel.
 */
export async function pushHandballBot(now = new Date(), deps: HandballBotDeps = DEFAULT_DEPS): Promise<HandballBotPushResult> {
  const out: HandballBotPushResult = { messages: 0, recipients: 0, fetches: 0 };
  if (!isHandballBotEnabled() && deps === DEFAULT_DEPS) return out;
  if (listSubscribers().length === 0) return out;
  const sicht = handballOverview();
  if (!sicht.configured) return out;
  const jetzt = now.getTime();
  protokollAufraeumen(now);

  for (const team of sicht.teams) {
    // --- Verlegungen und Absagen ---
    // Was der Abruf an einem gespeicherten Spiel geändert hat. Älter als ein
    // Tag wird nur gemerkt: Der erste Lauf mit Abonnenten soll nicht die
    // Verlegungen der ganzen Vorrunde nachliefern.
    for (const c of changesFor(team.team_id)) {
      const key = `${team.team_id}:${c.match_id}:change:${c.change_id}`;
      if (schonGeschickt(key)) continue;
      merke(key);
      if (jetzt - Date.parse(c.detected_at) > CHANGE_MAX_AGE_MS) continue;
      const m = team.matches.find(x => x.match_id === c.match_id);
      if (!m) continue;
      const n = await rundsenden(textAenderung(team, m, c), deps, c.kind === 'rescheduled' ? routenTastatur(m) : null, fuerTeam(team.team_id, ALLE), 'aenderung');
      out.messages++; out.recipients += n;
    }

    for (const m of team.matches) {
      const start = Date.parse(m.starts_at);
      const schluessel = (art: string) => `${team.team_id}:${m.match_id}:${art}`;

      // --- Ankündigung — je Chat zu seiner Zeit (`/erinnerung`) ---
      if (m.status === 'scheduled' && start > jetzt) {
        let gegnerSpiele: HandballMatch[] | null | undefined;
        let text: string | null = null;
        let n = 0;
        for (const abo of listSubscribers()) {
          if (abo.mode !== 'all' || !verfolgt(abo, team.team_id)) continue;
          const ab = ankuendigungFaelligAb(m.starts_at, abo.lead);
          if (ab === null || jetzt < ab) continue;
          // Einmal je Chat und Spiel — auch wenn der Vorlauf später geändert wird.
          const key = schluessel(`upcoming:${abo.chatId}`);
          if (schonGeschickt(key)) continue;
          if (text === null) {
            // Die letzten drei Ergebnisse des Gegners stehen nicht in der eigenen
            // Datenbank — ein Abruf seines Spielplans, einmal je Spiel, nach bestem Bemühen.
            if (gegnerSpiele === undefined) {
              try {
                gegnerSpiele = await fetchTeamMatches(gegnerId(m), m.season_id);
                out.fetches++;
              } catch (err) {
                // Der Tageslauf hat ihn vielleicht schon — dann lieber der von heute Morgen als keiner.
                gegnerSpiele = opponentFormFor(gegnerId(m))?.matches ?? null;
                serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Spielplan des Gegners nicht abrufbar');
              }
            }
            text = textAnkuendigung(team, m, now, gegnerSpiele);
          }
          merke(key);
          try {
            await deps.send(abo.chatId, text, ankuendigungTastatur(m));
            n++;
            protokolliere(abo.chatId, 'ankuendigung', true);
          } catch (err) {
            protokolliere(abo.chatId, 'ankuendigung', false, err);
            zustellungGescheitert(abo.chatId, err);
            continue;
          }
          // Direkt darunter die Halle als Ort — still, weil die Ankündigung
          // schon geklingelt hat. Nach bestem Bemühen: Die Ankündigung steht.
          const ort = halleAlsOrt(m);
          if (ort && deps.sendVenue) {
            try { await deps.sendVenue(abo.chatId, ort); } catch (err) {
              serviceLog.warn({ chat: abo.chatId, err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Halle als Ort nicht zustellbar');
            }
          }
        }
        if (n > 0) { out.messages++; out.recipients += n; }
      }

      // --- Spieltagsgruß — am Morgen eines Spieltags, einmal je Chat und Spiel ---
      // Nur, wer Ankündigungen will (nicht „keine") und alles; wer die Ankündigung
      // dieses Spiels schon bekommen hat (Vorabend, drei Stunden), braucht keinen Gruß.
      if (m.status === 'scheduled' && start > jetzt && spieltagsGrussFaellig(m, now)) {
        const text = textSpieltag(team, m, opponentFormFor(gegnerId(m))?.matches ?? null);
        let n = 0;
        for (const abo of listSubscribers()) {
          if (abo.mode !== 'all' || abo.lead === 'aus' || !verfolgt(abo, team.team_id)) continue;
          const key = schluessel(`morning:${abo.chatId}`);
          if (schonGeschickt(key) || schonGeschickt(schluessel(`upcoming:${abo.chatId}`))) continue;
          // Kommt die Ankündigung ohnehin in den nächsten zwei Stunden, wäre der Gruß ein Doppel.
          const ankuendigungAb = ankuendigungFaelligAb(m.starts_at, abo.lead);
          if (ankuendigungAb !== null && ankuendigungAb - jetzt < GRUSS_ABSTAND_ZUR_ANKUENDIGUNG_MS) continue;
          merke(key);
          try {
            await deps.send(abo.chatId, text, routenTastatur(m));
            n++;
            protokolliere(abo.chatId, 'ankuendigung', true);
          } catch (err) {
            protokolliere(abo.chatId, 'ankuendigung', false, err);
            zustellungGescheitert(abo.chatId, err);
          }
        }
        if (n > 0) { out.messages++; out.recipients += n; }
      }

      // --- Aufstellung ---
      const imFenster = jetzt - start >= LINEUP_FROM_MS && jetzt - start <= LINEUP_UNTIL_MS;
      if ((m.status === 'scheduled' || m.status === 'live') && imFenster && !schonGeschickt(schluessel('lineup'))) {
        try {
          const lineup = await fetchLineups(m.match_id);
          out.fetches++;
          const seite = eigeneSeite(lineup, team.team_id);
          if (seite && seite.players.length > 0) {
            merke(schluessel('lineup'));
            const n = await rundsenden(textAufstellung(team, m, seite), deps, null, fuerTeam(team.team_id, NUR_ALLES), 'aufstellung');
            out.messages++; out.recipients += n;
          }
        } catch (err) {
          // Nach bestem Bemühen: Ohne Aufstellung kommt der Endstand trotzdem.
          serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Aufstellung nicht abrufbar');
        }
      } else if (jetzt - start > LINEUP_UNTIL_MS && !schonGeschickt(schluessel('lineup'))) {
        // Fenster vorbei, nie gekommen — nicht ewig nachsehen.
        merke(schluessel('lineup'));
      }

      // --- Halbzeit ---
      const imHalbzeitFenster = jetzt - start >= HALFTIME_FROM_MS && jetzt - start <= HALFTIME_UNTIL_MS;
      if ((m.status === 'scheduled' || m.status === 'live') && imHalbzeitFenster && !schonGeschickt(schluessel('halftime'))) {
        try {
          const events = await fetchMatchEvents(m.match_id);
          out.fetches++;
          // Nebenbei für den Zeitzonen-Selbsttest: Wo lag der Anwurf, gemessen an der Spieluhr?
          merkeAnwurfSchaetzung(team.team_id, m.match_id, events, now);
          if (events.halftime) {
            merke(schluessel('halftime'));
            setzeHalbzeit(team.team_id, m.match_id, events.halftime.home, events.halftime.away);
            const n = await rundsenden(textHalbzeit(team, m, events.halftime), deps, halbzeitTastatur(), fuerTeam(team.team_id, NUR_ALLES), 'halbzeit');
            out.messages++; out.recipients += n;
          }
        } catch (err) {
          serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Torfolge nicht abrufbar');
        }
      } else if (jetzt - start > HALFTIME_UNTIL_MS && !schonGeschickt(schluessel('halftime'))) {
        merke(schluessel('halftime'));
      }

      // --- Endstand ---
      const mitStand = m.score_home !== null && m.score_away !== null;
      if (((m.status === 'finished' && mitStand) || m.rated) && !schonGeschickt(schluessel('result'))) {
        merke(schluessel('result'));
        // Gewertet ohne Stand (nur die Tabelle zählt es): ein Satz, keine Karte.
        if (m.rated && !mitStand) {
          if (jetzt - start > RATED_MAX_AGE_MS) continue;
          const n = await rundsenden(textEndstand(team, m, null), deps, endstandTastatur(m), fuerTeam(team.team_id, ALLE), 'endstand');
          out.messages++; out.recipients += n;
          continue;
        }
        // Nur, was frisch ist: Beim ersten Lauf nach dem Einrichten (oder nach
        // einem langen Ausfall) sollen nicht alle Endstände der Saison auf
        // einmal kommen. Der Job fasst bis sechs Stunden nach Anwurf nach —
        // was später erst als beendet auftaucht, ist Vergangenheit.
        if (jetzt - start > (m.rated ? RATED_MAX_AGE_MS : RESULT_MAX_AGE_MS)) continue;
        let seite: HandballLineupSide | null = null;
        // Die Bilanz **vor** diesem Spiel — für „erstes Saisontor" — muss vor dem Ablegen der Aufstellung gelesen werden.
        const vorher = playerStats(team.team_id, { excludeMatchId: m.match_id });
        try {
          seite = eigeneSeite(await fetchLineups(m.match_id), team.team_id);
          out.fetches++;
          if (seite) storeLineup(team.team_id, m.match_id, seite);
        } catch { /* Torschützen sind Beiwerk */ }
        const text = textEndstand(team, m, seite, namenAus(team.team_id), { vorher, bewegung: tabellenBewegung(team) });
        const bester = (seite?.players ?? []).filter(p => p.goals > 0).sort((a, b) => b.goals - a.goals || a.number - b.number)[0];
        const extras: EndstandKarteExtras = {
          playerOfMatch: bester ? `${namenAus(team.team_id)(bester.playerId) ?? `Nr. ${bester.number}`} · ${bester.goals} Tor${bester.goals === 1 ? '' : 'e'}` : null,
        };
        let png: Buffer | null = null;
        let gif: Buffer | null = null;
        if (deps.sendPhoto) {
          try {
            png = await svgAlsPng(await endstandBild(team, m, extras));
          } catch (err) {
            serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Endstand als Bild fehlgeschlagen — Textfassung');
          }
          if (png && deps.sendAnimation) {
            try {
              gif = await endstandAnimation(team, m, extras);
            } catch (err) {
              serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Endstand als Animation fehlgeschlagen — Foto');
            }
          }
        }
        // Zum Sieg Konfetti — nur in privaten Chats, siehe `mitEffekt`.
        const effekt = m.won === true ? KONFETTI_EFFECT_ID : null;
        const zustellung = png
          ? await rundsendenBild(png, text, 'endstand.png', deps, endstandTastatur(m), fuerTeam(team.team_id, ALLE), 'endstand', gif, effekt)
          : await anAlle(chatId => mitEffekt(chatId, effekt, x => deps.send(chatId, text, endstandTastatur(m), x)), fuerTeam(team.team_id, ALLE), 'endstand');
        out.messages++; out.recipients += zustellung.count;
        // Ein Sieg bekommt eine Reaktion auf die eigene Nachricht — Beiwerk, das lebendig wirkt.
        if (m.won === true && deps.react) {
          for (const z of zustellung.sent) {
            try { await deps.react(z.chatId, z.messageId, '🏆'); } catch { /* Telegram kennt das Emoji nicht oder der Chat erlaubt keine Reaktionen */ }
          }
        }
        // Der Spielbericht folgt nur auf einen Endstand, der wirklich rausging.
        merke(schluessel('result-sent'));
      }

      // --- Spielbericht ---
      // Nur nach einem gemeldeten Endstand, im Fenster; der Text der Quelle
      // kommt irgendwann nach dem Abpfiff, und `/bericht` liest ihn danach aus
      // der Datenbank.
      if (m.status === 'finished' && schonGeschickt(schluessel('result-sent')) && !schonGeschickt(schluessel('report'))) {
        if (jetzt - start > REPORT_UNTIL_MS) {
          merke(schluessel('report'));
        } else if (jetzt - start >= REPORT_FROM_MS) {
          try {
            const text = m.report_text ?? await fetchMatchReport(m.match_id);
            if (!m.report_text) out.fetches++;
            if (text) {
              merke(schluessel('report'));
              setzeBericht(team.team_id, m.match_id, text);
              const n = await rundsenden(textBericht(team, { ...m, report_text: text }, 'kurz'), deps, berichtTastatur(m, true), fuerTeam(team.team_id, ALLE), 'bericht');
              out.messages++; out.recipients += n;
            }
          } catch (err) {
            serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Spielbericht nicht abrufbar');
          }
        }
      }
    }

    // --- Saisonabschluss ---
    // Einmal je Mannschaft und Saison, wenn das letzte Spiel durch ist und
    // höchstens sieben Tage zurückliegt. Später wird nichts gemerkt: Wer den
    // Bot im Sommer einrichtet, bekommt die Karte über /saisonkarte.
    // Dazu eine Tabelle, die alle gespielten Spiele schon zählt: Der Endplatz
    // kommt aus ihr, und eine Tabelle vom Vortag nennte den falschen.
    const ende = saisonVorbei(team, now);
    const saisonKey = `${team.team_id}:${aktuellesSpiel(team.matches)?.season_id ?? 0}:saison`;
    const eigeneZeile = team.standings[0]?.rows.find(r => r.teamId === team.team_id);
    const gespieltZahl = team.matches.filter(m => m.status === 'finished' || m.rated).length;
    const tabelleAktuell = !!eigeneZeile && eigeneZeile.played >= gespieltZahl;
    if (ende.vorbei && ende.frisch && tabelleAktuell && !schonGeschickt(saisonKey)) {
      merke(saisonKey);
      const text = `🏅 <b>Die Saison ist vorbei.</b>\n${textSaison(team)}`;
      const svg = bildSaison(team);
      let png: Buffer | null = null;
      if (svg && deps.sendPhoto) {
        try { png = await svgAlsPng(svg); } catch (err) {
          serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-bot] Saisonkarte fehlgeschlagen — Textfassung');
        }
      }
      const zustellung = png
        ? await rundsendenBild(png, text, 'saison.png', deps, null, fuerTeam(team.team_id, ALLE), 'saison')
        : await anAlle(chatId => deps.send(chatId, text), fuerTeam(team.team_id, ALLE), 'saison');
      out.messages++; out.recipients += zustellung.count;
    }
  }
  return out;
}
