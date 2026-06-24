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
 *   GET https://poll.diaria.workers.dev/leaderboard/top1?period=YYYY-MM
 *     → { top1, podium: [{nickname, rank}], period, period_slug }
 *       (apenas nicknames — sem emails; preserva privacidade por design do worker)
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
 *
 * Uso:
 *   npx tsx scripts/build-poll-eia-data.ts [--dry-run] [--push] [--worker-url URL]
 *   npx tsx scripts/build-poll-eia-data.ts --push
 *   npx tsx scripts/build-poll-eia-data.ts --push --worker-url http://localhost:8787  # local test
 */

import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PollEiaSummary, PollEiaEditionEntry, PollEiaLeaderboardEntry } from "../workers/diaria-dashboard/src/types.ts";

// ─── Config ──────────────────────────────────────────────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data");
const OUT_PATH = join(DATA_DIR, "poll-eia-summary.json");

const DEFAULT_WORKER_URL = "https://poll.diaria.workers.dev";

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

interface LeaderboardTop1Response {
  top1: Array<{ nickname: string; pct: number; correct: number; total: number }>;
  podium: Array<{ nickname: string; rank: number }>;
  period: string;
  period_slug: string;
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
 * Busca leaderboard do mês via GET /leaderboard/top1?period=YYYY-MM.
 * Retorna null em erro. Só retorna nicknames (sem emails — privacidade by design).
 */
export async function fetchMonthLeaderboard(
  workerUrl: string,
  monthSlug: string,
): Promise<LeaderboardTop1Response | null> {
  const url = `${workerUrl}/leaderboard/top1?period=${encodeURIComponent(monthSlug)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      if (res.status !== 404 && res.status !== 400) {
        console.warn(`[poll-eia] /leaderboard/top1?period=${monthSlug} → HTTP ${res.status}`);
      }
      return null;
    }
    const json = await res.json() as LeaderboardTop1Response;
    return json;
  } catch (e) {
    console.warn(`[poll-eia] fetch /leaderboard/top1?period=${monthSlug} falhou: ${(e as Error).message}`);
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
        } satisfies PollEiaEditionEntry;
      }),
    );
    for (const r of results) {
      if (r !== null) editionResults.push(r);
    }
  }

  // Ordena desc (mais recente primeiro) para o dashboard
  editionResults.sort((a, b) => (b.edition > a.edition ? 1 : -1));

  const last_edition = editionResults.length > 0 ? editionResults[0].edition : null;

  // 2. Busca leaderboard por mês único (para construir top 10 global)
  //    /leaderboard/top1 retorna o podium (ranks 1-3) do mês — sem opção de top 10 completo.
  //    Acumulamos o pódio de cada mês e dedupamos por nickname para aproximar o top global.
  const monthSlugs = editionsToMonthSlugs(editions);
  const lbByNickname = new Map<string, { correct: number; total: number; streak: number }>();

  for (let i = 0; i < monthSlugs.length; i += BATCH) {
    const batch = monthSlugs.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((slug) => fetchMonthLeaderboard(workerUrl, slug)),
    );
    for (const lb of results) {
      if (!lb) continue;
      // /leaderboard/top1 retorna podium [{nickname, rank}]. Acumulamos correct/total via
      // top1 se disponível, ou apenas o nickname via podium (sem métricas de top1 individuais).
      const top1Map = new Map<string, { correct: number; total: number; pct: number }>(
        (lb.top1 ?? []).map((e) => [e.nickname, { correct: e.correct, total: e.total, pct: e.pct }]),
      );

      for (const entry of lb.podium ?? []) {
        const name = entry.nickname;
        // Filtrar display names de teste (defesa; normalmente vazio pós-purge)
        if (EDITOR_TEST_DISPLAY_NAMES.has(name)) continue;

        const metrics = top1Map.get(name);
        const existing = lbByNickname.get(name);
        if (existing) {
          // Acumula correct+total entre meses (aproximação: top1 só em rank 1)
          if (metrics) {
            existing.correct += metrics.correct;
            existing.total += metrics.total;
          }
        } else {
          lbByNickname.set(name, {
            correct: metrics?.correct ?? 0,
            total: metrics?.total ?? 0,
            streak: 0, // streak não exposto pelo /leaderboard/top1 (acumulado global)
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
      streak: v.streak,
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

function parseArgs(argv: string[]): { dryRun: boolean; push: boolean; workerUrl: string } {
  const dryRun = argv.includes("--dry-run") || !argv.includes("--push");
  const push = argv.includes("--push");
  const workerUrlIdx = argv.indexOf("--worker-url");
  const workerUrl = workerUrlIdx >= 0 ? (argv[workerUrlIdx + 1] ?? DEFAULT_WORKER_URL) : DEFAULT_WORKER_URL;
  return { dryRun, push, workerUrl };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { push, workerUrl } = args;

  console.log(`[poll-eia] worker URL: ${workerUrl}`);

  const editionsDir = join(DATA_DIR, "editions");
  const editions = discoverEditions(editionsDir);

  if (editions.length === 0) {
    console.warn("[poll-eia] Nenhuma edição encontrada em data/editions/ — abortando");
    process.exit(0);
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
  } else {
    console.log("[poll-eia] Modo --dry-run: arquivo NÃO gravado. Use --push para persistir.");
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
