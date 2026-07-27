#!/usr/bin/env node
// Usage:
//   npx tsx scripts/eia-log-used.ts \
//     --edition 260420 \
//     --image-date 2026-04-15 \
//     --title "File:Example.jpg" \
//     --credit "Photographer Name, CC BY-SA 4.0" \
//     --url "https://..."
//
// Appends an entry to data/eia-used.json so future editions skip already-used POTDs.
// Uses process.argv (safe from shell injection) instead of string interpolation
// inside a `node -e` one-liner.

import fs from 'fs';
// #4125 (item 7): eia-log-used.ts e sync-eia-used.ts fazem read-JSON →
// mutate → writeFileSync em data/eia-used.json SEM lock — 2 execuções
// concorrentes (padrão documentado neste projeto, ex: writer-destaque ×3 em
// paralelo no Stage 2, ou overnight/develop rodando lotes concorrentes) fazem
// a 2ª sobrescrever a entrada da 1ª, e uma edição futura pode selecionar foto
// já usada sem erro visível. Mesmo mecanismo de lock já usado por
// scripts/lib/social-published-store.ts (#758/#918) — reusado, não
// reinventado (ver scripts/lib/file-lock.ts). `withFileLock` (não só
// acquireLock/releaseLock crus) porque o call site abaixo é exatamente o
// padrão acquire→try→finally-release que o helper existe pra encapsular.
import { withFileLock } from './lib/file-lock.ts';

interface UsedEntry {
  // Format do edition_date varia historicamente: novas entries usam YYMMDD
  // (`260520`); entries pre-#1417 podem ter ISO (`2026-05-20`). `readUsedTitles`
  // em eia-compose.ts trata ambos comparando string igualdade.
  edition_date: string;
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

const LOG_PATH = 'data/eia-used.json';

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

// #4125 (item 7): read-modify-write inteiro sob lock — sem isso, 2 execuções
// concorrentes (ex: pipeline rodando em paralelo com um backfill manual)
// podiam interlear loadLog()...writeFileSync() e a 2ª escrita sobrescrever a
// entrada da 1ª silenciosamente. `.lock` ao lado de LOG_PATH, mesmo mecanismo
// de scripts/lib/social-published-store.ts (ver scripts/lib/file-lock.ts).
const lockPath = LOG_PATH + '.lock';
const result = withFileLock(lockPath, () => {
  const log: UsedEntry[] = loadLog();

  const entry: UsedEntry = {
    edition_date: edition,
    image_date: imageDate,
    title,
    credit: credit ?? '',
    url,
    used_at: new Date().toISOString(),
  };

  // #1417: re-runs (--force) da mesma edição acumulavam N entries; remove
  // prior entries da mesma edição antes de append. Mantém só o último — que
  // é o que vai pro deploy. eia-compose.ts::readUsedTitles também filtra
  // entries da própria edição no read-path, então essa cleanup é cosmético
  // (mantém o arquivo enxuto) mais do que correção funcional.
  const prior = log.length;
  const cleaned = log.filter((e) => e.edition_date !== edition);
  const dropped = prior - cleaned.length;
  cleaned.push(entry);
  // #4125 (item 7): escrita atômica via tmp+rename — mesmo padrão de
  // social-published-store.ts (rename é atômico no filesystem, nunca deixa
  // LOG_PATH pela metade se o processo for interrompido no meio do write).
  const tmpPath = LOG_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(cleaned, null, 2) + '\n');
  fs.renameSync(tmpPath, LOG_PATH);

  return { logged: entry, total_entries: cleaned.length, dropped_prior_same_edition: dropped };
});

console.log(JSON.stringify(result));
