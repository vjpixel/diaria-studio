#!/usr/bin/env tsx
/**
 * rebuild-stats.ts (#1757)
 *
 * Reconstrói o counter `stats:{edition}` do Worker `poll` a partir das keys
 * `vote:{edition}:{email}` (source of truth). Conserta o drift que acontece
 * quando votos são deletados FORA do `purge-leaderboard.ts` (ex: deleção
 * manual via `wrangler kv key delete`) — a deleção tira a vote key mas NÃO
 * decrementa o counter agregado, deixando `/stats` (e o "X% acertaram" da
 * newsletter) inflado.
 *
 * Caso real (260603): editor votou pra testar + deletou; counters
 * `stats:260601`/`stats:260602` ficaram inflados (14/9) vs votos reais (8/7),
 * publicando 44% quando o real era 57%.
 *
 * Uso:
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
 *     npx tsx scripts/rebuild-stats.ts --edition 260602            # dry-run
 *     npx tsx scripts/rebuild-stats.ts --edition 260602 --execute  # grava
 *
 * Dry-run é o default — mostra current vs rebuilt sem escrever.
 *
 * Exit codes:
 *   0 = OK (counter já batia, ou foi reconstruído com --execute)
 *   1 = drift detectado em dry-run (current != rebuilt) — rode com --execute
 *   2 = erro de uso (env/args ausentes)
 */

import "dotenv/config";

export interface VoteRecord {
  choice: "A" | "B";
  ts?: string;
  correct: boolean | null;
}

export interface StatsRecord {
  total: number;
  voted_a: number;
  voted_b: number;
  correct_count: number;
}

/**
 * Pure (#1757): reconstrói o StatsRecord a partir da lista de votos reais.
 * `total` = nº de votos (1 por email/edição, já que vote keys são deduped no
 * Worker). `correct_count` só conta `correct === true` (votos antes do gabarito
 * têm `correct: null` e não somam). Exportada pra teste.
 */
export function computeStatsFromVotes(votes: VoteRecord[]): StatsRecord {
  const stats: StatsRecord = { total: 0, voted_a: 0, voted_b: 0, correct_count: 0 };
  for (const v of votes) {
    stats.total += 1;
    if (v.choice === "A") stats.voted_a += 1;
    else if (v.choice === "B") stats.voted_b += 1;
    if (v.correct === true) stats.correct_count += 1;
  }
  return stats;
}

/** Pure: compara dois StatsRecord campo a campo. Exportada pra teste. */
export function statsEqual(a: StatsRecord, b: StatsRecord): boolean {
  return (
    a.total === b.total &&
    a.voted_a === b.voted_a &&
    a.voted_b === b.voted_b &&
    a.correct_count === b.correct_count
  );
}

const NAMESPACE_ID = "72784da4ae39444481eb422ebac357c6"; // POLL namespace

function parseArgs(argv: string[]): { edition: string | null; execute: boolean } {
  let edition: string | null = null;
  let execute = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--edition" && argv[i + 1]) {
      edition = argv[i + 1];
      i++;
    } else if (argv[i] === "--execute") {
      execute = true;
    }
  }
  return { edition, execute };
}

async function mainCli(): Promise<number> {
  const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
  const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
  if (!ACCOUNT_ID || !API_TOKEN) {
    console.error("Erro: CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_API_TOKEN obrigatórios no env");
    return 2;
  }
  const { edition, execute } = parseArgs(process.argv.slice(2));
  if (!edition || !/^\d{6}$/.test(edition)) {
    console.error("Uso: rebuild-stats.ts --edition AAMMDD [--execute]");
    return 2;
  }

  const KV_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}`;
  const authHeaders = { Authorization: `Bearer ${API_TOKEN}` };

  // Listar vote:{edition}:* keys (paginado)
  const voteKeys: string[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ prefix: `vote:${edition}:`, limit: "1000" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${KV_BASE}/keys?${params}`, { headers: authHeaders });
    if (!res.ok) {
      console.error(`KV list falhou: ${res.status} ${await res.text()}`);
      return 2;
    }
    const json = (await res.json()) as {
      result: Array<{ name: string }>;
      result_info: { cursor?: string };
    };
    voteKeys.push(...json.result.map((k) => k.name));
    cursor = json.result_info.cursor || undefined;
  } while (cursor);

  // Ler cada voto
  const votes: VoteRecord[] = [];
  for (const key of voteKeys) {
    const res = await fetch(`${KV_BASE}/values/${encodeURIComponent(key)}`, { headers: authHeaders });
    if (res.status === 404) continue;
    if (!res.ok) {
      console.error(`KV get ${key} falhou: ${res.status}`);
      return 2;
    }
    try {
      votes.push(JSON.parse(await res.text()) as VoteRecord);
    } catch {
      console.error(`[skip] ${key} parse error`);
    }
  }

  const rebuilt = computeStatsFromVotes(votes);

  // Ler counter atual
  const sKey = `stats:${edition}`;
  const curRes = await fetch(`${KV_BASE}/values/${encodeURIComponent(sKey)}`, { headers: authHeaders });
  const current: StatsRecord | null = curRes.ok
    ? (JSON.parse(await curRes.text()) as StatsRecord)
    : null;

  console.log(`[rebuild-stats] edição ${edition}: ${voteKeys.length} vote keys reais`);
  console.log(`  current : ${current ? JSON.stringify(current) : "(ausente)"}`);
  console.log(`  rebuilt : ${JSON.stringify(rebuilt)}`);

  if (current && statsEqual(current, rebuilt)) {
    console.log("[rebuild-stats] counter já bate — nada a fazer.");
    return 0;
  }

  if (!execute) {
    console.log("[rebuild-stats] DRIFT detectado — rode com --execute pra reconstruir.");
    return 1;
  }

  const putRes = await fetch(`${KV_BASE}/values/${encodeURIComponent(sKey)}`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify(rebuilt),
  });
  if (!putRes.ok) {
    console.error(`KV put ${sKey} falhou: ${putRes.status} ${await putRes.text()}`);
    return 2;
  }
  console.log(`[rebuild-stats] ${sKey} reconstruído → ${JSON.stringify(rebuilt)}`);
  return 0;
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (/\/scripts\/rebuild-stats\.ts$/.test(_argv1)) {
  mainCli().then((code) => process.exit(code));
}
