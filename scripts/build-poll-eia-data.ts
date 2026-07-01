#!/usr/bin/env npx tsx
/**
 * build-poll-eia-data.ts (#2475)
 *
 * Agrega dados do poll "É IA?" via endpoints públicos do worker `poll`
 * (https://poll.diaria.workers.dev) e grava data/poll-eia-summary.json —
 * arquivo consumido por `build-diaria-dashboard-data.ts` via `buildPollEiaSummary`.
 *
 * Abordagem (b) — push/agregador:
 *   Consome endpoints públicos do worker poll; NÃO lê KV cross-worker diretamente
 *   (requereria namespace+token que o editor não configurou neste script).
 *
 * Endpoints consumidos:
 *   GET https://poll.diaria.workers.dev/stats?edition=AAMMDD
 *     → { total, voted_a, voted_b, correct_answer, correct_count, correct_pct }
 *       (brand=diaria implícito — não precisa de ?brand=)
 *   GET https://poll.diaria.workers.dev/leaderboard/{YYYY-MM}.json
 *     → { entries: [{rank, medal, nickname, correct, total, pct}], period_slug }
 *       (novo endpoint #2475 — expõe métricas para TODOS os ranks, não só rank 1)
 *
 * Limitação conhecida (#2475):
 *   O endpoint /stats agrega TODOS os votos, incluindo os votos de teste do editor
 *   (pixel@memelab.com.br + vjpixel@gmail.com). Excluir esses votos dos totais por
 *   edição requer acesso cross-worker ao KV (abordagem a — descartada #2475).
 *   Workaround: o /diaria-remover-votos-pixel já remove esses votos do KV
 *   periodicamente; rodar o skill antes do --push minimiza o impacto.
 *   Para o leaderboard, o worker só expõe nicknames — votos de teste já devem ter
 *   sido purgados pelo /diaria-remover-votos-pixel.
 *
 * Modos:
 *   --dry-run  (default): gera preview no stdout, NÃO escreve data/poll-eia-summary.json
 *   --push     escreve data/poll-eia-summary.json (lido pelo build-diaria-dashboard-data.ts)
 *              E TAMBÉM sobe um payload slim (`editions`, sem leaderboard/PII) pro
 *              KV do clarice-dashboard (chave `eia:engagement`, #2738 — aba
 *              Engajamento). Mesma agregação, dois destinos — sem pipeline
 *              duplicada. Requer CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_WORKERS_TOKEN
 *              (mesmas credenciais dos outros pushes de KV do dashboard); se
 *              ausentes, loga aviso e segue (fail-soft — não aborta o --push
 *              principal, que já escreveu o arquivo local com sucesso).
 *
 * Uso:
 *   npx tsx scripts/build-poll-eia-data.ts [--dry-run] [--push] [--worker-url URL]
 *   npx tsx scripts/build-poll-eia-data.ts --push
 *   npx tsx scripts/build-poll-eia-data.ts --push --worker-url http://localhost:8787  # local test
 */

import { existsSync, readdirSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PollEiaSummary, PollEiaEditionEntry, PollEiaLeaderboardEntry } from "../workers/diaria-dashboard/src/types.ts";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { DASHBOARD_KV_NAMESPACE_ID } from "./lib/dashboard-kv.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";

// #2738: chave KV do clarice-dashboard pro engajamento do "É IA?" (aba Engajamento).
const EIA_ENGAGEMENT_KV_KEY = "eia:engagement";

// ─── Config ──────────────────────────────────────────────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data");
const OUT_PATH = join(DATA_DIR, "poll-eia-summary.json");

/**
 * #2475 self-review: lê a URL do worker poll de platform.config.json (poll.worker_url)
 * em vez de hardcoded. Fallback para o literal se o arquivo/campo estiver ausente
 * (ex: clone fresco antes de configurar). Strip trailing slash para consistência.
 */
function readDefaultWorkerUrl(): string {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
    const url = cfg?.poll?.worker_url;
    if (typeof url === "string" && url.length > 0) return url.replace(/\/$/, "");
  } catch {
    // arquivo ausente/inválido → cai no literal default
  }
  return "https://poll.diaria.workers.dev";
}

const DEFAULT_WORKER_URL = readDefaultWorkerUrl();

/** Editions com editions de teste do editor — excluídas do leaderboard se apareceram
 * como display_name (improvável pós-purge, mas defensivo). */
const EDITOR_TEST_DISPLAY_NAMES = new Set<string>([
  // Não sabemos o nickname do editor; manter set vazio mas pronto para uso.
  // Votos do editor são purgados via /diaria-remover-votos-pixel antes do --push.
]);

// ─── Tipos locais dos endpoints do worker poll ────────────────────────────────

interface PollStatsResponse {
  edition: string;
  total: number;
  voted_a: number;
  voted_b: number;
  correct_answer: string | null;
  correct_count: number;
  correct_pct: number | null;
}

interface LeaderboardJsonResponse {
  entries: Array<{
    rank: number;
    medal: string;
    nickname: string;
    correct: number;
    total: number;
    pct: number;
  }>;
  period_slug: string;
  message?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Converte AAMMDD → "YYYY-MM" (slug do mês de publicação).
 * Retorna null se input mal-formado. Mesma lógica de editionToMonthSlug no worker.
 */
export function editionToMonthSlug(edition: string): string | null {
  if (!/^\d{6}$/.test(edition)) return null;
  const yy = edition.slice(0, 2);
  const mm = edition.slice(2, 4);
  const mmNum = parseInt(mm, 10);
  if (mmNum < 1 || mmNum > 12) return null;
  return `20${yy}-${mm}`;
}

/**
 * Descobre edições disponíveis em data/editions/ (AAMMDD, ordem crescente).
 * Retorna array vazio se diretório não existe.
 */
export function discoverEditions(editionsDir: string): string[] {
  if (!existsSync(editionsDir)) return [];
  try {
    return readdirSync(editionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{6}$/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Descobre os slugs de meses únicos a partir de uma lista de edições.
 * Retorna slugs YYYY-MM ordenados cronologicamente.
 */
export function editionsToMonthSlugs(editions: string[]): string[] {
  const slugs = new Set<string>();
  for (const ed of editions) {
    const slug = editionToMonthSlug(ed);
    if (slug) slugs.add(slug);
  }
  return [...slugs].sort();
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

/**
 * Busca stats de uma edição via GET /stats?edition=AAMMDD.
 * Retorna null em erro (404 = edição sem votos, ou worker indisponível).
 * Nunca lança — degradação graciosa (edição sem votos = skip silencioso).
 */
export async function fetchEditionStats(
  workerUrl: string,
  edition: string,
): Promise<PollStatsResponse | null> {
  const url = `${workerUrl}/stats?edition=${encodeURIComponent(edition)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // 404 / 400 → edição sem dados — silencioso; outras = log warn
      if (res.status !== 404 && res.status !== 400) {
        console.warn(`[poll-eia] /stats?edition=${edition} → HTTP ${res.status}`);
      }
      return null;
    }
    const json = await res.json() as PollStatsResponse;
    // Guard: total=0 com correct_pct=null é edição sem votos — skip para não poluir o dashboard
    if (typeof json.total !== "number" || json.total === 0) return null;
    return json;
  } catch (e) {
    console.warn(`[poll-eia] fetch /stats?edition=${edition} falhou: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Busca leaderboard do mês via GET /leaderboard/{YYYY-MM}.json (#2475).
 * Retorna null em erro. Expõe correct/total para TODOS os ranks (resolve o bug
 * onde ranks 2/3 apareciam com zeros no dashboard).
 */
export async function fetchMonthLeaderboardJson(
  workerUrl: string,
  monthSlug: string,
): Promise<LeaderboardJsonResponse | null> {
  const url = `${workerUrl}/leaderboard/${encodeURIComponent(monthSlug)}.json`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      if (res.status !== 404 && res.status !== 400) {
        console.warn(`[poll-eia] /leaderboard/${monthSlug}.json → HTTP ${res.status}`);
      }
      return null;
    }
    const data = await res.json() as LeaderboardJsonResponse;
    if (!Array.isArray(data.entries)) return null;
    return data;
  } catch (e) {
    console.warn(`[poll-eia] fetch /leaderboard/${monthSlug}.json falhou: ${(e as Error).message}`);
    return null;
  }
}

// ─── Agregação ────────────────────────────────────────────────────────────────

/**
 * buildPollEiaSummaryFromApi (#2475)
 *
 * Agrega dados do poll É IA? via endpoints públicos do worker poll.
 *
 * Per-edição: /stats?edition=AAMMDD → total, voted_a, voted_b, correct_choice, pct_correct
 * Leaderboard: /leaderboard/top1?period=YYYY-MM → podium com nicknames (top 10 aproximado via meses)
 *
 * Nota sobre votos de teste do editor:
 *   O endpoint /stats é agregado — NÃO é possível excluir votos de pixel@memelab.com.br
 *   e vjpixel@gmail.com dos totais por edição via API pública. Rodar /diaria-remover-votos-pixel
 *   antes do --push remove esses votos do KV, o que reflete nos dados do /stats subsequentemente.
 *   Para o leaderboard (podium), o worker expõe apenas nicknames — sem emails, sem possibilidade
 *   de filtrar por email. Votos de teste purificados pelo /diaria-remover-votos-pixel não aparecem.
 *
 * @param editions  Lista de edições AAMMDD (vem de discoverEditions)
 * @param workerUrl Base URL do worker poll (default: https://poll.diaria.workers.dev)
 */
export async function buildPollEiaSummaryFromApi(
  editions: string[],
  workerUrl: string = DEFAULT_WORKER_URL,
): Promise<PollEiaSummary> {
  // 1. Busca stats de cada edição (paralelo com throttle 5 concurrent)
  const BATCH = 5;
  const editionResults: PollEiaEditionEntry[] = [];

  for (let i = 0; i < editions.length; i += BATCH) {
    const batch = editions.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (edition) => {
        const stats = await fetchEditionStats(workerUrl, edition);
        if (!stats) return null;
        return {
          edition,
          total_votes: stats.total,
          voted_a: stats.voted_a,
          voted_b: stats.voted_b,
          pct_correct: stats.correct_pct,
          correct_choice: stats.correct_answer,
          correct_count: stats.correct_count,
        } satisfies PollEiaEditionEntry;
      }),
    );
    for (const r of results) {
      if (r !== null) editionResults.push(r);
    }
  }

  // Ordena desc (mais recente primeiro) para o dashboard
  editionResults.sort((a, b) => (b.edition > a.edition ? 1 : -1));
  if (editionResults.length > 20) {
    console.log(`[poll-eia] truncando ${editionResults.length} edições → top 20 (mais recentes)`);
  }

  const last_edition = editionResults.length > 0 ? editionResults[0].edition : null;

  // 2. Busca leaderboard por mês único (para construir top 10 global)
  //    /leaderboard/{YYYY-MM}.json retorna entries completos (rank, correct, total) —
  //    resolve o bug #2475 onde ranks 2/3 apareciam com zeros.
  const monthSlugs = editionsToMonthSlugs(editionResults.map((r) => r.edition));
  const lbByNickname = new Map<string, { correct: number; total: number; rank: number }>();

  for (let i = 0; i < monthSlugs.length; i += BATCH) {
    const batch = monthSlugs.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((slug) => fetchMonthLeaderboardJson(workerUrl, slug)),
    );
    for (const lb of results) {
      if (!lb) continue;
      for (const entry of lb.entries) {
        const name = entry.nickname;
        // Filtrar display names de teste (defesa; normalmente vazio pós-purge)
        if (EDITOR_TEST_DISPLAY_NAMES.has(name)) continue;

        const existing = lbByNickname.get(name);
        if (existing) {
          // Acumula correct+total entre meses; mantém o melhor rank histórico
          existing.correct += entry.correct;
          existing.total += entry.total;
          if (entry.rank < existing.rank) existing.rank = entry.rank;
        } else {
          lbByNickname.set(name, {
            correct: entry.correct,
            total: entry.total,
            rank: entry.rank,
          });
        }
      }
    }
  }

  // Ordena leaderboard por correct desc, total desc (mesma lógica do worker)
  const leaderboard: PollEiaLeaderboardEntry[] = [...lbByNickname.entries()]
    .map(([nickname, v]) => ({
      display_name: nickname,
      correct: v.correct,
      total: v.total,
      streak: 0, // streak não exposto pelo endpoint JSON (acumulado global)
    }))
    .sort((a, b) => {
      if (b.correct !== a.correct) return b.correct - a.correct;
      if (b.total !== a.total) return b.total - a.total;
      return a.display_name.localeCompare(b.display_name);
    })
    .slice(0, 10);

  return {
    source: "push",
    last_edition,
    editions: editionResults.slice(0, 20), // máximo 20 edições no dashboard
    leaderboard,
    updated_at: new Date().toISOString(),
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { push: boolean; workerUrl: string } {
  const push = argv.includes("--push");
  const workerUrlIdx = argv.indexOf("--worker-url");
  const workerUrl = workerUrlIdx >= 0
    ? (argv[workerUrlIdx + 1] && !argv[workerUrlIdx + 1].startsWith("--"))
      ? argv[workerUrlIdx + 1]
      : (() => { console.error("[poll-eia] Erro: --worker-url requer um valor (ex: http://localhost:8787)"); process.exit(1); })()
    : DEFAULT_WORKER_URL;
  return { push, workerUrl };
}

async function main(): Promise<void> {
  // #2738: CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN (usados por
  // pushEiaEngagementToBrevoKv) vêm de .env.local — sem isso, o push falha
  // silenciosamente (fail-soft) mesmo com os secrets configurados na máquina
  // (mesmo padrão de stripe-coupon-usage.ts/clarice-mv-status.ts/clarice-db-summary.ts).
  loadProjectEnv();
  const args = parseArgs(process.argv.slice(2));
  const { push, workerUrl } = args;
  const dryRun = !push;

  console.log(`[poll-eia] worker URL: ${workerUrl}`);

  const editionsDir = join(DATA_DIR, "editions");
  const editions = discoverEditions(editionsDir);

  if (editions.length === 0) {
    console.error("[poll-eia] Erro: nenhuma edição encontrada em data/editions/ — verifique se a junction OneDrive está montada");
    process.exit(1);
  }

  console.log(`[poll-eia] ${editions.length} edições em data/editions/ — buscando stats...`);

  const summary = await buildPollEiaSummaryFromApi(editions, workerUrl);

  console.log(JSON.stringify({
    editions_with_data: summary.editions.length,
    last_edition: summary.last_edition,
    leaderboard_entries: summary.leaderboard.length,
    updated_at: summary.updated_at,
  }, null, 2));

  if (push) {
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, JSON.stringify(summary, null, 2) + "\n", "utf8");
    console.log(`[poll-eia] ✓ Escrito em ${OUT_PATH}`);
    console.log("[poll-eia] Próximo passo: npx tsx scripts/build-diaria-dashboard-data.ts --push");

    await pushEiaEngagementToBrevoKv(summary);
  } else {
    console.log("[poll-eia] Modo --dry-run: arquivo NÃO gravado. Use --push para persistir.");
  }
}

/**
 * #2738: sobe um payload SLIM (só `editions` + `updated_at` — sem leaderboard,
 * que é PII-adjacent/específico do diaria-dashboard) pro KV do clarice-dashboard,
 * chave `eia:engagement` (aba Engajamento). Fail-soft: sem as credenciais
 * Cloudflare, loga aviso e retorna — NUNCA aborta o --push principal, que já
 * escreveu o arquivo local com sucesso antes desta chamada.
 */
/**
 * #2738: extrai do `PollEiaSummary` completo (que carrega `leaderboard` com
 * nicknames — PII-adjacent, específico do workers/diaria-dashboard) só o que
 * a aba Engajamento do clarice-dashboard precisa: `editions` + `updated_at`.
 * Função PURA e exportada separadamente — garante, com teste dedicado, que um
 * futuro edit não troque isso por `JSON.stringify(summary)` inteiro (o que
 * vazaria `leaderboard` pro KV do outro dashboard).
 */
export function buildEiaEngagementKvPayload(
  summary: PollEiaSummary,
): { editions: PollEiaEditionEntry[]; updated_at: string | null } {
  return {
    editions: summary.editions,
    updated_at: summary.updated_at,
  };
}

export async function pushEiaEngagementToBrevoKv(summary: PollEiaSummary): Promise<void> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_WORKERS_TOKEN ?? "";
  if (!accountId || !token) {
    console.warn(
      "[poll-eia] CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN ausentes — pulei o push pro " +
        "KV do clarice-dashboard (aba Engajamento, #2738). O arquivo local já foi escrito normalmente.",
    );
    return;
  }
  const payload = buildEiaEngagementKvPayload(summary);
  try {
    await uploadTextToWorkerKV(JSON.stringify(payload), EIA_ENGAGEMENT_KV_KEY, {
      kvNamespaceId: DASHBOARD_KV_NAMESPACE_ID,
      accountId,
      token,
      contentType: "application/json",
    });
    console.log(`[poll-eia] ✓ KV atualizado: ${EIA_ENGAGEMENT_KV_KEY} (aba Engajamento do clarice-dashboard).`);
  } catch (err) {
    // Fail-soft: o arquivo local (consumido por build-diaria-dashboard-data.ts)
    // já foi escrito com sucesso antes desta chamada — uma falha aqui (ex:
    // API do Cloudflare fora do ar) não pode aparentar que o --push inteiro falhou.
    console.warn(
      `[poll-eia] push pro KV do clarice-dashboard falhou (não bloqueia): ${err instanceof Error ? err.message : err}`,
    );
  }
}

// CLI guard (#cli-guard): só executa main() quando invocado diretamente
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(`[poll-eia] ${(e as Error).message}`);
    process.exit(1);
  });
}
