/**
 * Baut `src/**` nach `dist/` — derselbe esbuild-Weg wie in Todoteck, Datei
 * für Datei (kein Bundle), damit `dist/index.js` seine Nachbarn wie im
 * Quelltext findet und `drizzle/` neben `dist/` liegen kann.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function findTsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') results.push(...findTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

const files = findTsFiles('src');
execSync(
  `npx esbuild ${files.join(' ')} --outdir=dist --platform=node --target=es2020 --format=cjs --outbase=src`,
  { stdio: 'inherit' },
);
