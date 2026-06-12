#!/usr/bin/env tsx
/**
 * backfill-score-by-month.ts (#1345)
 *
 * Migration one-shot: lê todos os votes existentes em production KV
 * (`vote:{edition}:{email}`) e populates `score-by-month:{YYYY-MM}:{email}`.
 *
 * Necessário rodar 1× após deploy do Worker pra preservar histórico — sem
 * isso, `/leaderboard/2026-05` antes de junho mostraria entries só dos
 * votos pós-deploy.
 *
 * Uso:
 *   CLOUDFLARE_API_TOKEN=... \
 *   CLOUDFLARE_ACCOUNT_ID=5d15d8303325211d6976d73051f4b002 \
 *     npx tsx scripts/backfill-score-by-month.ts
 *
 *   # Dry-run (não escreve):
 *   npx tsx scripts/backfill-score-by-month.ts --dry-run
 *
 *   # Clear-first (#1347 followup) — deleta score-by-month:* existentes
 *   # antes de recomputar. Garante idempotência se rodar 2x:
 *   npx tsx scripts/backfill-score-by-month.ts --clear-first
 *
 *   # Combinar:
 *   npx tsx scripts/backfill-score-by-month.ts --dry-run --clear-first
 *
 * Pre-req: Worker já deployed com /vote registrando em score-by-month.
 * Pos-condição: todos os votes existentes refletidos nas keys mensais.
 *
 * Idempotência (#1347): rodar sem --clear-first é seguro só se NENHUM vote
 * chegou desde a run anterior. Se houver votos intermediários, eles serão
 * sobrescritos com o estado recomputado (~equivale a perda). Use --clear-first
 * em re-runs de produção.
 */

// #2130: A extensão `.ts` no import abaixo é intencional — convenção do repo (tsx).
// Quebraria com `node --experimental-strip-types` (que exige `.js`), mas esse
// script é executado exclusivamente via `npx tsx` (ver shebang acima). NÃO
// normalizar para `.js` sem migrar o runner do repo inteiro.
import "dotenv/config";
import { editionToMonthSlug } from "../workers/poll/src/lib.ts";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const NAMESPACE_ID = "72784da4ae39444481eb422ebac357c6"; // POLL namespace

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error("Erro: CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_API_TOKEN obrigatórios no env");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const clearFirst = process.argv.includes("--clear-first");

interface VoteRecord {
  choice: "A" | "B";
  ts: string;
  correct: boolean | null;
}

interface ScoreRecord {
  nickname: string | null;
  [k: string]: unknown;
}

interface MonthEntry {
  total: number;
  correct: number;
  last_edition: string | null;
  nickname: string | null;
}

const KV_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}`;

async function kvList(prefix: string): Promise<string[]> {
  const all: string[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ prefix, limit: "1000" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${KV_BASE}/keys?${params}`, {
      headers: { "Authorization": `Bearer ${API_TOKEN}` },
    });
    if (!res.ok) throw new Error(`KV list failed: ${res.status} ${await res.text()}`);
    const json = await res.json() as { result: Array<{ name: string }>; result_info: { cursor?: string; count: number } };
    all.push(...json.result.map((k) => k.name));
    cursor = json.result_info.cursor || undefined;
  } while (cursor);
  return all;
}

async function kvGet(key: string): Promise<string | null> {
  const res = await fetch(`${KV_BASE}/values/${encodeURIComponent(key)}`, {
    headers: { "Authorization": `Bearer ${API_TOKEN}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV get ${key} failed: ${res.status}`);
  return await res.text();
}

async function kvPut(key: string, value: string): Promise<void> {
  if (dryRun) {
    console.log(`[dry-run] PUT ${key} (${value.length} bytes)`);
    return;
  }
  const res = await fetch(`${KV_BASE}/values/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${API_TOKEN}` },
    body: value,
  });
  if (!res.ok) throw new Error(`KV put ${key} failed: ${res.status} ${await res.text()}`);
}

async function kvDelete(key: string): Promise<void> {
  if (dryRun) {
    console.log(`[dry-run] DELETE ${key}`);
    return;
  }
  const res = await fetch(`${KV_BASE}/values/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${API_TOKEN}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`KV delete ${key} failed: ${res.status} ${await res.text()}`);
  }
}

// #2123: editionToMonthSlug importado da fonte canônica (workers/poll/src/lib.ts —
// módulo puro, sem deps de runtime do Worker). A cópia local anterior divergiu
// silenciosamente no #2115; import direto elimina a classe de bug.

async function main(): Promise<void> {
  console.log(`[backfill] mode: ${dryRun ? "DRY-RUN" : "WRITE"}${clearFirst ? " (with --clear-first)" : ""}`);

  // #1347 followup: opcional clear de score-by-month:* antes de re-popular.
  // Sem isso, rodar 2x não é totalmente idempotente — votes que chegaram
  // entre run 1 e run 2 são sobrescritos pelo estado pré-incremento.
  // Com --clear-first: deleta tudo, depois recomputa do zero — garantia
  // de consistência com o source-of-truth (vote:*).
  if (clearFirst) {
    console.log("[backfill] --clear-first: listando score-by-month:* pra delete...");
    const existing = await kvList("score-by-month:");
    console.log(`[backfill] deletando ${existing.length} score-by-month:* keys existentes`);
    for (let i = 0; i < existing.length; i++) {
      await kvDelete(existing[i]);
      if ((i + 1) % 100 === 0) {
        console.log(`[backfill] deleted ${i + 1}/${existing.length}`);
      }
    }
    console.log("[backfill] --clear-first: limpeza completa");
  }

  console.log("[backfill] listando vote:* keys...");
  const voteKeys = await kvList("vote:");
  console.log(`[backfill] ${voteKeys.length} votes pra processar`);

  // (slug, email) → entry agregado
  const entries = new Map<string, MonthEntry>();

  let processed = 0;
  for (const key of voteKeys) {
    // key shape: "vote:{edition}:{email}"
    const parts = key.split(":");
    if (parts.length < 3) continue;
    const edition = parts[1];
    const email = parts.slice(2).join(":"); // emails com `:` (raro mas defensive)

    const slug = editionToMonthSlug(edition);
    if (!slug) continue;

    const voteRaw = await kvGet(key);
    if (!voteRaw) continue;
    const vote = JSON.parse(voteRaw) as VoteRecord;

    const entryKey = `${slug}|${email}`;
    const entry = entries.get(entryKey) ?? {
      total: 0,
      correct: 0,
      last_edition: null,
      nickname: null,
    };
    entry.total += 1;
    if (vote.correct === true) entry.correct += 1;
    if (entry.last_edition === null || edition > entry.last_edition) {
      entry.last_edition = edition;
    }
    entries.set(entryKey, entry);

    processed++;
    if (processed % 100 === 0) {
      console.log(`[backfill] processed ${processed}/${voteKeys.length}`);
    }
  }

  console.log(`[backfill] agregação completa: ${entries.size} (slug, email) entries`);

  // Buscar nickname de cada email (1 req per email único)
  const emails = new Set<string>();
  for (const k of entries.keys()) emails.add(k.split("|")[1]);
  console.log(`[backfill] buscando nicknames de ${emails.size} emails...`);

  const nicknames = new Map<string, string | null>();
  for (const email of emails) {
    const scoreRaw = await kvGet(`score:${email}`);
    if (!scoreRaw) {
      nicknames.set(email, null);
      continue;
    }
    const score = JSON.parse(scoreRaw) as ScoreRecord;
    nicknames.set(email, score.nickname ?? null);
  }

  // Write entries com nickname populated
  console.log(`[backfill] escrevendo ${entries.size} score-by-month keys...`);
  let written = 0;
  for (const [combinedKey, entry] of entries.entries()) {
    const [slug, email] = combinedKey.split("|");
    entry.nickname = nicknames.get(email) ?? null;
    const kvKey = `score-by-month:${slug}:${email}`;
    await kvPut(kvKey, JSON.stringify(entry));
    written++;
    if (written % 100 === 0) {
      console.log(`[backfill] written ${written}/${entries.size}`);
    }
  }

  console.log(`[backfill] done — ${written} keys ${dryRun ? "would be written" : "written"}`);
}

main().catch((e) => {
  console.error("[backfill] erro:", e);
  process.exit(1);
});
