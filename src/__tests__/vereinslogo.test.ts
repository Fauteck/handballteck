import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { unlinkSync } from 'fs';

/**
 * `CLUB_LOGO_TEAMS`: Mannschaften, die in Bildern und auf der Seite das
 * Vereinslogo tragen statt des Logos (oder der Initialen) von handball.net.
 */

process.env.DATABASE_PATH = `/tmp/handball-vereinslogo-${process.pid}.db`;

let team: typeof import('../lib/handballTeam');
let speichern: (id: string, mime: string, at: string) => void;

beforeAll(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
  const { db } = await import('../db');
  const { handball_team_logo } = await import('../db/schema');
  speichern = (id, mime, at) => {
    db.insert(handball_team_logo).values({ team_id: id, source_url: `https://x/${id}.png`, mime_type: mime, image: Buffer.from(id), fetched_at: at }).run();
  };
  team = await import('../lib/handballTeam');
});

afterEach(() => {
  delete process.env.TEAM_IDS; delete process.env.CLUB_LOGO_TEAMS; delete process.env.CLUB_TEAM_IDS;
});

afterAll(() => {
  for (const f of ['', '-wal', '-shm']) { try { unlinkSync(`${process.env.DATABASE_PATH}${f}`); } catch { /* nicht da */ } }
});

describe('Vereinslogo je Mannschaft', () => {
  it('zeigt ohne Häkchen das eigene Logo von handball.net — oder keins', () => {
    speichern('100', 'image/png', '2026-11-01T10:00:00.000Z');
    speichern('300', 'image/jpeg', '2026-11-02T10:00:00.000Z');
    process.env.TEAM_IDS = '100,200,300';
    expect(team.logoDataUri('100')).toBe(`data:image/png;base64,${Buffer.from('100').toString('base64')}`);
    expect(team.logoDataUri('200')).toBeNull();
    expect(team.logoVersion('200')).toBeNull();
  });

  it('nimmt mit Häkchen das Logo der ersten Mannschaft ohne Häkchen, die eins hat — auch statt eines eigenen', () => {
    process.env.TEAM_IDS = '100,200,300';
    process.env.CLUB_LOGO_TEAMS = '200,300';
    expect(team.vereinsLogoTeam()).toBe('100');
    expect(team.logoDataUri('200')).toBe(team.logoDataUri('100'));
    expect(team.logoDataUri('300')).toBe(team.logoDataUri('100'));
    // Die Fassung nennt die Quelle: Ein- und Ausschalten ergibt eine neue Adresse.
    expect(team.logoVersion('300')).not.toBe(team.logoVersion('100'));
    expect(team.logoVersion('300')!.startsWith(team.logoVersion('100')!)).toBe(true);
  });

  it('bleibt beim eigenen Logo, wenn keine Mannschaft ohne Häkchen eins hat', () => {
    process.env.TEAM_IDS = '100,200,300';
    process.env.CLUB_LOGO_TEAMS = '100,200,300';
    expect(team.vereinsLogoTeam()).toBeNull();
    expect(team.logoDataUri('300')).toBe(`data:image/jpeg;base64,${Buffer.from('300').toString('base64')}`);
    expect(team.logoDataUri('200')).toBeNull();
  });
});
