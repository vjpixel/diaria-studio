/**
 * eia-refresh.ts (#3257)
 *
 * Refresh sob demanda dos votos do poll "É IA?" pra aba Engajamento — botão
 * "Atualizar" na UI (perto da tabela "Por edição"), sem precisar do editor
 * rodar `npx tsx scripts/build-poll-eia-data.ts --push` no terminal.
 *
 * Reimplementa, DENTRO do Worker, o mesmo pipeline de agregação que
 * `scripts/build-poll-eia-data.ts` já faz localmente pro ramo MENSAL
 * (brand=clarice) — a aba Engajamento do clarice-dashboard só mostra ciclos
 * mensais, nunca edições diárias (ver doc de `EIA_ENGAGEMENT_KV_KEY` em
 * types.ts).
 *
 * Obstáculo original (#3257): o script decide QUAIS ciclos consultar via
 * `discoverMonthlyCycles()`, que lê `data/monthly/` — diretório local (junction
 * OneDrive), inacessível a um Worker Cloudflare. Resolvido pela direção
 * RECOMENDADA da própria issue (opção 1b): o worker `poll` já sabe quais
 * edições/ciclos têm stats registrados — expõe isso via `GET /editions`
 * (#3257, ver workers/poll/src/vote.ts::handleEditions). Este módulo consome
 * esse endpoint novo em vez de duplicar `data/monthly/` no runtime do Worker.
 *
 * Diferença adicional vs. o script: grava DIRETO no KV `STATS_CACHE` deste
 * worker (binding local) — não precisa das credenciais Cloudflare
 * cross-worker (CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN) que
 * `pushEiaEngagementToBrevoKv` exige no script (ele escreve de FORA do
 * worker, via API HTTP; aqui já rodamos dentro dele).
 */

import type { Env, EiaEngagementEdition, EiaEngagementSummary } from "./types.ts";
import { EIA_ENGAGEMENT_KV_KEY } from "./types.ts";

/** Mesmo default de `scripts/build-poll-eia-data.ts` (readDefaultWorkerUrl). */
export const DEFAULT_POLL_WORKER_URL = "https://poll.diaria.workers.dev";

/** Máximo de ciclos mantidos no payload — mesmo teto do script (`buildPollEiaSummaryFromApi`). */
const MAX_EDITIONS = 20;

/** Concorrência de fetch pro worker poll — mesmo BATCH do script. */
const FETCH_BATCH = 5;

interface PollStatsResponse {
  edition: string;
  total: number;
  voted_a: number;
  voted_b: number;
  correct_answer: string | null;
  correct_count: number;
  correct_pct: number | null;
}

interface PollEditionsResponse {
  brand: string;
  editions: string[];
}

/**
 * Busca a lista de ciclos MENSAIS (YYMM-MM) com stats registrados no worker
 * `poll` (brand=clarice) via `GET /editions` (#3257). Lança em erro de
 * rede/HTTP/shape — o caller (`refreshEiaEngagement`) converte pra
 * `{ok:false}`. Exportado pra teste.
 */
export async function fetchClariceEditions(workerUrl: string): Promise<string[]> {
  const url = `${workerUrl}/editions?brand=clarice`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GET /editions?brand=clarice → HTTP ${res.status}`);
  const data = (await res.json()) as PollEditionsResponse;
  if (!Array.isArray(data.editions)) {
    throw new Error("GET /editions: payload malformado (editions não é array)");
  }
  // Só ciclos MENSAIS (YYMM-MM) — mesmo filtro de discoverMonthlyCycles() no
  // script (o /editions do poll worker pode devolver AAMMDD diário também,
  // dependendo do brand; aqui só nos interessa o formato mensal).
  return data.editions.filter((e) => /^\d{4}-\d{2}$/.test(e));
}

/**
 * Busca stats de 1 ciclo via `GET /stats?edition=X&brand=clarice`.
 * `null` = sem dado (404/erro/total=0) — nunca lança, mesmo comportamento
 * fail-soft de `fetchEditionStats` no script (edição sem votos = skip).
 * Exportado pra teste.
 */
export async function fetchCycleStats(workerUrl: string, cycle: string): Promise<PollStatsResponse | null> {
  const url = `${workerUrl}/stats?edition=${encodeURIComponent(cycle)}&brand=clarice`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as PollStatsResponse;
    if (typeof json.total !== "number" || json.total === 0) return null;
    return json;
  } catch {
    return null;
  }
}

/**
 * Agrega os ciclos mensais retornados por `/editions` em `EiaEngagementSummary`
 * — mesmo shape gravado por `buildEiaEngagementKvPayload` no script, truncado
 * às `MAX_EDITIONS` mais recentes. Exportado pra teste (função pura de
 * agregação, sem side-effect de KV).
 */
export async function buildEiaEngagementFromPoll(
  workerUrl: string = DEFAULT_POLL_WORKER_URL,
): Promise<EiaEngagementSummary> {
  const cycles = await fetchClariceEditions(workerUrl);
  const editions: EiaEngagementEdition[] = [];

  for (let i = 0; i < cycles.length; i += FETCH_BATCH) {
    const batch = cycles.slice(i, i + FETCH_BATCH);
    const results = await Promise.all(batch.map((cycle) => fetchCycleStats(workerUrl, cycle)));
    for (let j = 0; j < results.length; j++) {
      const stats = results[j];
      if (!stats) continue;
      editions.push({
        edition: batch[j],
        total_votes: stats.total,
        voted_a: stats.voted_a,
        voted_b: stats.voted_b,
        pct_correct: stats.correct_pct,
        correct_choice: stats.correct_answer,
        correct_count: stats.correct_count,
      });
    }
  }

  // Mais recente primeiro — mesma convenção do script.
  editions.sort((a, b) => (b.edition > a.edition ? 1 : -1));

  return {
    editions: editions.slice(0, MAX_EDITIONS),
    updated_at: new Date().toISOString(),
  };
}

export type RefreshEiaEngagementResult =
  | { ok: true; editionsCount: number }
  | { ok: false; error: string };

/**
 * Handler do botão "Atualizar" — busca + agrega + grava direto no KV
 * `STATS_CACHE` deste worker. Nunca lança — qualquer falha (rede, HTTP,
 * shape, binding ausente) vira `{ok:false, error}` pro caller decidir a
 * resposta HTTP, mesmo padrão fail-soft do resto do dashboard (#738 não se
 * aplica aqui — não é um MCP, é um botão de UI opcional; falhar sem quebrar
 * a página é o comportamento certo).
 */
export async function refreshEiaEngagement(
  env: Env,
  workerUrl: string = DEFAULT_POLL_WORKER_URL,
): Promise<RefreshEiaEngagementResult> {
  try {
    if (!env.STATS_CACHE) return { ok: false, error: "STATS_CACHE KV binding ausente" };
    const summary = await buildEiaEngagementFromPoll(workerUrl);
    await env.STATS_CACHE.put(EIA_ENGAGEMENT_KV_KEY, JSON.stringify(summary));
    return { ok: true, editionsCount: summary.editions.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
