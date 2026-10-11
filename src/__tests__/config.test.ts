/**
 * Die Proxy-Liste (`TRUST_PROXY`): nur IP- und CIDR-Einträge, leer heißt
 * keinem trauen — und nie `true`, das jedem Aufrufer jede Adresse glaubte.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { trustProxy, syncLiveIntervalMs, clubName, clubTeamIds } from '../config';

afterEach(() => {
  for (const n of ['TRUST_PROXY', 'SYNC_LIVE_INTERVAL_MS', 'CLUB_NAME', 'CLUB_TEAM_IDS']) delete process.env[n];
});

describe('TRUST_PROXY', () => {
  it('vertraut ohne Angabe keinem Proxy', () => {
    expect(trustProxy()).toBe(false);
    process.env.TRUST_PROXY = '   ';
    expect(trustProxy()).toBe(false);
  });

  it('nimmt Adressen und Bereiche, durch Komma oder Leerzeichen getrennt', () => {
    process.env.TRUST_PROXY = '10.0.0.5, 172.16.0.0/12  ::1';
    expect(trustProxy()).toEqual(['10.0.0.5', '172.16.0.0/12', '::1']);
  });

  it('wird durch „true" oder eine Zahl nicht zu „allen vertrauen"', () => {
    process.env.TRUST_PROXY = 'true';
    expect(trustProxy()).toBe(false);
    process.env.TRUST_PROXY = 'loopback, 10.0.0.5';
    expect(trustProxy()).toEqual(['10.0.0.5']);
  });
});

describe('Live-Takt und Vereinsname', () => {
  it('tickt standardmäßig jede Minute, 0 schaltet ab, kleine Werte werden angehoben', () => {
    expect(syncLiveIntervalMs()).toBe(60_000);
    process.env.SYNC_LIVE_INTERVAL_MS = '0';
    expect(syncLiveIntervalMs()).toBe(0);
    process.env.SYNC_LIVE_INTERVAL_MS = '5000';
    expect(syncLiveIntervalMs()).toBe(20_000);
  });

  it('liest CLUB_TEAM_IDS als Liste von IDs und kennt einen Standardnamen', () => {
    expect(clubTeamIds().size).toBe(0);
    expect(clubName()).toBe('HSG Wölfe Voreifel');
    process.env.CLUB_TEAM_IDS = '111, 222;abc';
    process.env.CLUB_NAME = 'SG Test';
    expect([...clubTeamIds()]).toEqual(['111', '222']);
    expect(clubName()).toBe('SG Test');
  });
});
