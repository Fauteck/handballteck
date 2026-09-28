import { eq } from 'drizzle-orm';
import { db } from '../db';
import { settings } from '../db/schema';

export function getSetting(key: string): string | null {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const now = new Date().toISOString();
  db.insert(settings).values({ key, value, updated_at: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updated_at: now } })
    .run();
}
