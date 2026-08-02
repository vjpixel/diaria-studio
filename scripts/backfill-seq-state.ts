#!/usr/bin/env tsx
/**
 * backfill-seq-state.ts (#4443)
 *
 * Migration one-shot: lê todos os `web:vote:{edition}:{email}` já existentes
 * em produção KV e monta o agregado mensal `web:seq:{month}:{email}` (mapa
 * `edição -> gabarito`) que `GET /jogar/seq-state` (workers/poll/src/jogar.ts,
 * `handleJogarSeqState`) passou a consumir no #4443 — 1 get por mês em vez de
 * até 2 por edição.
 *
 * Por que rodar ANTES de descer o worker `poll` pro plano GRÁTIS do
 * Cloudflare (motivação original da issue): sem o agregado pré-existente,
 * a PRIMEIRA leitura de um mês fechado cai no fallback por edição (até
 * 31-62 gets) e o self-heal só grava o agregado DEPOIS dessa 1ª leitura cara
 * — no free plan (teto de 50/request) essa 1ª leitura estouraria antes do
 * self-heal ter chance de rodar. Rodar este backfill primeiro elimina essa
 * janela pra todo mês JÁ FECHADO.
 *
 * Escopo: só o brand `web` — `/jogar/seq-state` é exclusivo dele (ver
 * rationale em `handleJogarSeqState`, jogar.ts). Backfillar `seq:` pros
 * brands `diaria`/`clarice` seria desperdício: `updateScoreByMonth` (vote.ts)
 * já escreve o agregado deles a partir de agora pra frente (mesmo
 * bookkeeping, todos os brands), mas NINGUÉM lê `seq:{month}:{email}` fora
 * do brand `web` hoje — não há endpoint equivalente pra diária/Clarice.
 *
 * Por padrão, SÓ processa meses JÁ FECHADOS (estritamente anteriores ao mês
 * corrente em BRT) — o mês corrente recebe o agregado organicamente pelos
 * votos que ainda estão chegando (via `updateScoreByMonth`, que já escreve
 * `seq:` desde o #4443); rodar o backfill nele também correria o mesmo risco
 * de "-clear-first sobre dado ainda em mudança" já documentado em
 * `backfill-score-by-month.ts`. Use `--include-current-month` pra cobrir o
 * mês corrente mesmo assim (ex: reprocessar depois de um erro).
 *
 * Uso:
 *   CLOUDFLARE_API_TOKEN=... \
 *   CLOUDFLARE_ACCOUNT_ID=5d15d8303325211d6976d73051f4b002 \
 *     npx tsx scripts/backfill-seq-state.ts
 *
 *   # Dry-run (não escreve):
 *   npx tsx scripts/backfill-seq-state.ts --dry-run
 *
 *   # Clear-first — deleta web:seq:* existentes antes de recomputar (garante
 *   # consistência com a fonte de verdade, web:vote:*, caso um self-heal
 *   # anterior tenha gravado um agregado PARCIAL):
 *   npx tsx scripts/backfill-seq-state.ts --clear-first
 *
 *   # Inclui o mês corrente (normalmente pulado, ver rationale acima):
 *   npx tsx scripts/backfill-seq-state.ts --include-current-month
 *
 * Pre-req: nenhum — `vote:` já existe desde o #3516 (fundação do "É IA?"
 * standalone). Pos-condição: `web:seq:{month}:{email}` reflete todo o
 * histórico de `web:vote:*` pros meses fechados.
 *
 * Idempotência: SEM `--clear-first`, rodar 2x é seguro só se nenhum voto
 * chegou pro MESMO (mês, email) desde a run anterior — mesma ressalva de
 * `backfill-score-by-month.ts`. Como o escopo default exclui o mês corrente
 * (onde chegam votos novos), isso na prática só importa pro edge case de
 * voto retroativo no arquivo (`/jogar?edition=X` numa edição já fechada).
 * Use `--clear-first` em re-runs de produção pra eliminar a ambiguidade.
 */

// #2130: a extensão `.ts` no import abaixo é intencional — convenção do repo
// (tsx). Ver o mesmo comentário em backfill-score-by-month.ts.
import "dotenv/config";
import { editionToMonthSlug, todayAammddBrt } from "../workers/poll/src/lib.ts";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const NAMESPACE_ID = "72784da4ae39444481eb422ebac357c6"; // POLL namespace (mesmo de backfill-score-by-month.ts)

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error("Erro: CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_API_TOKEN obrigatórios no env");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const clearFirst = process.argv.includes("--clear-first");
const includeCurrentMonth = process.argv.includes("--include-current-month");

interface VoteRecord {
  choice: "A" | "B";
  ts: string;
  correct: boolean | null;
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
    console.log(`[backfill-seq-state] [dry-run] PUT ${key} (${value.length} bytes)`);
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
    console.log(`[backfill-seq-state] [dry-run] DELETE ${key}`);
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

async function main(): Promise<void> {
  console.log(
    `[backfill-seq-state] mode: ${dryRun ? "DRY-RUN" : "WRITE"}` +
    `${clearFirst ? " (with --clear-first)" : ""}` +
    `${includeCurrentMonth ? " (incluindo mês corrente)" : ""}`,
  );

  const currentMonth = editionToMonthSlug(todayAammddBrt(new Date()));

  if (clearFirst) {
    console.log("[backfill-seq-state] --clear-first: listando web:seq:* pra delete...");
    const existing = await kvList("web:seq:");
    // Sem --include-current-month, preserva o agregado do mês corrente — ele
    // é mantido organicamente pelos votos que chegam via updateScoreByMonth
    // (vote.ts) e não deve ser apagado por um backfill que não vai recompô-lo.
    const toDelete = includeCurrentMonth
      ? existing
      : existing.filter((k) => !currentMonth || !k.startsWith(`web:seq:${currentMonth}:`));
    console.log(`[backfill-seq-state] deletando ${toDelete.length}/${existing.length} web:seq:* keys existentes`);
    for (let i = 0; i < toDelete.length; i++) {
      await kvDelete(toDelete[i]);
      if ((i + 1) % 100 === 0) console.log(`[backfill-seq-state] deleted ${i + 1}/${toDelete.length}`);
    }
    console.log("[backfill-seq-state] --clear-first: limpeza completa");
  }

  console.log("[backfill-seq-state] listando web:vote:* keys...");
  const voteKeys = await kvList("web:vote:");
  console.log(`[backfill-seq-state] ${voteKeys.length} votes (brand web) pra processar`);

  // (monthSlug, identity) → agregado { edição -> gabarito }
  const aggregates = new Map<string, Record<string, boolean | null>>();
  let skippedCurrentMonth = 0;
  let skippedMalformed = 0;

  let processed = 0;
  for (const key of voteKeys) {
    // key shape: "web:vote:{edition}:{identity}" — o prefixo "web:" já foi
    // consumido pelo `kvList("web:vote:")` acima, então o NAME retornado pela
    // API já vem completo (com "web:"); removemos aqui pra parsear o resto.
    const withoutBrand = key.startsWith("web:") ? key.slice(4) : key;
    const parts = withoutBrand.split(":");
    if (parts.length < 3 || parts[0] !== "vote") {
      skippedMalformed++;
      continue;
    }
    const edition = parts[1];
    const identity = parts.slice(2).join(":"); // identidade (email real ou pseudo-email) pode conter ":" — defensive

    const monthSlug = editionToMonthSlug(edition);
    if (!monthSlug) {
      skippedMalformed++;
      continue;
    }
    if (!includeCurrentMonth && monthSlug === currentMonth) {
      skippedCurrentMonth++;
      continue;
    }

    const voteRaw = await kvGet(key);
    if (!voteRaw) continue;
    let vote: VoteRecord;
    try {
      vote = JSON.parse(voteRaw) as VoteRecord;
    } catch {
      skippedMalformed++;
      continue;
    }
    const correct = typeof vote.correct === "boolean" ? vote.correct : null;

    const aggKey = `${monthSlug}|${identity}`;
    const agg = aggregates.get(aggKey) ?? {};
    agg[edition] = correct;
    aggregates.set(aggKey, agg);

    processed++;
    if (processed % 100 === 0) console.log(`[backfill-seq-state] processed ${processed}/${voteKeys.length}`);
  }

  console.log(
    `[backfill-seq-state] agregação completa: ${aggregates.size} (mês, identidade) pares` +
    ` — ${skippedCurrentMonth} votos do mês corrente pulados, ${skippedMalformed} registros malformados pulados`,
  );

  console.log(`[backfill-seq-state] escrevendo ${aggregates.size} web:seq:* keys...`);
  let written = 0;
  for (const [combinedKey, agg] of aggregates.entries()) {
    const [monthSlug, identity] = combinedKey.split("|");
    const kvKey = `web:seq:${monthSlug}:${identity}`;
    await kvPut(kvKey, JSON.stringify(agg));
    written++;
    if (written % 100 === 0) console.log(`[backfill-seq-state] written ${written}/${aggregates.size}`);
  }

  console.log(`[backfill-seq-state] done — ${written} keys ${dryRun ? "would be written" : "written"}`);
}

main().catch((e) => {
  console.error("[backfill-seq-state] erro:", e);
  process.exit(1);
});
