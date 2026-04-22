#!/usr/bin/env node
// Usage:
//   npx tsx scripts/eai-log-used.ts \
//     --edition 260420 \
//     --image-date 2026-04-15 \
//     --title "File:Example.jpg" \
//     --credit "Photographer Name, CC BY-SA 4.0" \
//     --url "https://..."
//
// Appends an entry to data/eai-used.json so future editions skip already-used POTDs.
// Uses process.argv (safe from shell injection) instead of string interpolation
// inside a `node -e` one-liner.

import fs from 'fs';

interface UsedEntry {
  edition_date: string;   // YYMMDD of the edition the image was used in
  image_date: string;     // Date the POTD was published (YYYY-MM-DD)
  title: string;          // Wikimedia file title (e.g. "File:Example.jpg")
  credit: string;         // Full credit string
  url: string;            // Canonical image URL
  used_at: string;        // ISO timestamp of when we logged it
}

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx === -1 ? undefined : args[idx + 1];
}

const edition = getArg('edition');
const imageDate = getArg('image-date');
const title = getArg('title');
const credit = getArg('credit');
const url = getArg('url');

if (!edition || !imageDate || !title || !url) {
  console.error('Missing required arg. Need: --edition --image-date --title --url [--credit]');
  process.exit(2);
}

const LOG_PATH = 'data/eai-used.json';

// Schema changed from { used: [...] } (legacy) to top-level array.
// Migrate on read so a stale local file doesn't crash log.push().
function loadLog(): UsedEntry[] {
  if (!fs.existsSync(LOG_PATH)) return [];
  const parsed = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  if (Array.isArray(parsed)) return parsed as UsedEntry[];
  if (parsed && Array.isArray((parsed as { used?: unknown }).used)) {
    return (parsed as { used: UsedEntry[] }).used;
  }
  throw new Error(
    `Unexpected shape in ${LOG_PATH}: expected array or { used: [...] }. Delete or fix the file and retry.`
  );
}

const log: UsedEntry[] = loadLog();

const entry: UsedEntry = {
  edition_date: edition,
  image_date: imageDate,
  title,
  credit: credit ?? '',
  url,
  used_at: new Date().toISOString(),
};

log.push(entry);
fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2) + '\n');

console.log(JSON.stringify({ logged: entry, total_entries: log.length }));
