/**
 * Textmetrik für die SVG-Bilder — in Todoteck ein Teil von
 * `lib/displayRender.ts` (E-Ink-Anzeige), hier die drei Funktionen, die die
 * Handball-Bilder brauchen. Die Breitenschätzung ist an DejaVu Sans
 * angelehnt; die Bilder rechnen damit eher zu breit, kürzen also höchstens
 * früher, überlappen aber nie.
 */

const CHAR_WIDTH: Record<string, number> = {};
for (const c of 'ijl|!.,;:\'`') CHAR_WIDTH[c] = 0.30;
for (const c of '()[]{}/\\ft') CHAR_WIDTH[c] = 0.39;
for (const c of 'r-') CHAR_WIDTH[c] = 0.42;
for (const c of '0123456789') CHAR_WIDTH[c] = 0.636;
for (const c of 'abcdeghknopqsuvxyzäöüß') CHAR_WIDTH[c] = 0.62;
for (const c of 'ABCDEFGHIJKLNOPQRSTUVXYZÄÖÜ') CHAR_WIDTH[c] = 0.70;
for (const c of 'mMwW') CHAR_WIDTH[c] = 0.95;
CHAR_WIDTH[' '] = 0.318;

export function estimateTextWidth(text: string, fontSize: number, bold = false): number {
  let em = 0;
  for (const c of text) em += CHAR_WIDTH[c] ?? 0.62;
  return em * fontSize * (bold ? 1.06 : 1);
}

/** Kürzt auf die verfügbare Breite und hängt ein Auslassungszeichen an. */
export function truncateToWidth(text: string, fontSize: number, maxWidth: number, bold = false): string {
  if (estimateTextWidth(text, fontSize, bold) <= maxWidth) return text;
  let out = '';
  for (const c of text) {
    if (estimateTextWidth(`${out}${c}…`, fontSize, bold) > maxWidth) break;
    out += c;
  }
  return `${out.trimEnd()}…`;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
