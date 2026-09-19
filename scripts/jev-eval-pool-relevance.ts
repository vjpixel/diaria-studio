/**
 * jev-eval-pool-relevance.ts (#8418 — medição 5 do epic #8412)
 *
 * Mede se Jev (2 perguntas `noul`: `about_ai` + `audience_fit`, ver
 * `scripts/lib/jev-questions.ts` → `POOL_RELEVANCE_8418_*`) filtraria itens
 * que o editor de fato aprovou (falso-positivo GRAVE — o pior caso, um item
 * que virou destaque/pool final sendo descartado antes mesmo de chegar ao
 * categorizador/scorer).
 *
 * Diferente de `jev-eval-negative-impact.ts` (#8414), esta medição NÃO usa
 * `blind-label-core.ts` — o "rótulo verdade" aqui não é um julgamento
 * subjetivo que precise de rotulagem cega por um humano: é o desfecho
 * EDITORIAL objetivo já registrado nos arquivos da edição —
 * `aprovado` (o item sobreviveu de `01-categorized.json` até
 * `01-approved.json`, isto é, virou destaque ou ficou no pool final) vs.
 * `descartado` (estava categorizado mas não sobreviveu — cortado pelo
 * scorer ou pelo editor no gate). Não há nada pra "esconder" de um rotulador
 * humano porque não há rotulador humano nesta medição — daí pular
 * `blind-label-sample.ts --record`.
 *
 * Pool: candidatos de `data/editions/{AAMMDD}/_internal/01-categorized.json`
 * (buckets `lancamento`/`radar`/`use_melhor`/`video` — mesmo conjunto usado
 * por `BUCKET_TIEBREAKER_8211_FEATURE`), cruzados contra os mesmos buckets
 * de `01-approved.json` pra decidir `aprovado`/`descartado`. `highlights` é
 * sempre subconjunto de `radar`/`lancamento` nas edições inspecionadas
 * (verificado ao vivo, 260919) — não soma candidato extra.
 *
 * Uso:
 *   npx tsx scripts/jev-eval-pool-relevance.ts [--threshold-pct 30] [--runs 3] [--root /path/pro/checkout/com/data] [--limit 80] [--editions 260427,260622]
 *
 * `--root` existe porque este harness pode rodar de um worktree sem a
 * junction `data/` do OneDrive montada — aponte pro checkout que tem
 * `data/editions/` de verdade (main checkout). `TYPESAFE_API_KEY` vem do
 * `.env`/Doppler via `loadProjectEnv`, resolvido a partir do MESMO `--root`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getIntArg, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { askJevBatch, type JevNoulAnswer } from "./lib/jev.ts";
import { POOL_RELEVANCE_8418_ABOUT_AI, POOL_RELEVANCE_8418_AUDIENCE_FIT } from "./lib/jev-questions.ts";

const SELF_ROOT = resolve(import.meta.dirname, "..");
const BUCKETS = ["lancamento", "radar", "use_melhor", "video"] as const;

export type PoolDecision = "aprovado" | "descartado";

export interface PoolCandidate {
  id: string; // url
  edition: string;
  title: string;
  url: string;
  summary: string;
  decision: PoolDecision;
}

function bucketUrls(doc: Record<string, unknown>): Set<string> {
  const urls = new Set<string>();
  for (const b of BUCKETS) {
    for (const raw of (doc[b] as any[]) ?? []) {
      const a = raw?.article ?? raw;
      if (a?.url) urls.add(a.url);
    }
  }
  return urls;
}

/**
 * Coleta candidatos de TODAS as edições reais (AAMMDD) sob `rootDir` que têm
 * `01-categorized.json` + `01-approved.json`. `decision` = `aprovado` se a
 * URL sobreviveu até `01-approved.json` no MESMO bucket-family, `descartado`
 * caso contrário. Dedup por URL (1ª edição em que aparece vence — mesma
 * política de `seen` já usada pelas features de #8413/#8414).
 */
export function collectPoolRelevanceCandidates(rootDir: string, editionsFilter?: string[]): { candidates: PoolCandidate[]; skipped: string[] } {
  const editionsRoot = join(rootDir, "data", "editions");
  const candidates: PoolCandidate[] = [];
  const skipped: string[] = [];
  if (!existsSync(editionsRoot)) return { candidates, skipped };

  // Ordem determinística (AAMMDD crescente) pro dedup "1ª ocorrência vence" —
  // `enumerateEditionDirs` devolve um `Map` cuja ordem de iteração vem de
  // `readdirSync` (ordem de sistema de arquivos, não garantida
  // cronológica/alfabética); sem este sort, qual edição "vence" o dedup
  // dependeria do SO/filesystem, não da intenção declarada no comentário
  // acima (review finding P3, PR #8474).
  const editionsSorted = [...enumerateEditionDirs(editionsRoot)].sort(([a], [b]) => a.localeCompare(b));

  const seen = new Set<string>();
  for (const [edition, dir] of editionsSorted) {
    if (editionsFilter && !editionsFilter.includes(edition)) continue;
    const pc = join(dir, "_internal", "01-categorized.json");
    const pa = join(dir, "_internal", "01-approved.json");
    if (!existsSync(pc) || !existsSync(pa)) continue;
    let C: Record<string, unknown>;
    let A: Record<string, unknown>;
    try {
      C = JSON.parse(readFileSync(pc, "utf8"));
      A = JSON.parse(readFileSync(pa, "utf8"));
    } catch (e) {
      skipped.push(`${edition} (${e instanceof Error ? e.message.slice(0, 60) : "JSON inválido"})`);
      continue;
    }
    const approvedUrls = bucketUrls(A);
    for (const b of BUCKETS) {
      for (const raw of (C[b] as any[]) ?? []) {
        const a = raw?.article ?? raw;
        if (!a?.url || !a?.title) continue;
        if (seen.has(a.url)) continue;
        seen.add(a.url);
        candidates.push({
          id: a.url,
          edition,
          title: a.title,
          url: a.url,
          summary: String(a.summary ?? ""),
          decision: approvedUrls.has(a.url) ? "aprovado" : "descartado",
        });
      }
    }
  }
  return { candidates, skipped };
}

export interface PoolRelevanceResult {
  id: string;
  edition: string;
  decision: PoolDecision;
  probAboutAi: number | null;
  probAudienceFit: number | null;
  poolFiltered: boolean | null; // true = Jev filtraria (ambas abaixo do limiar)
}

/**
 * `poolFiltered` = TRUE quando AMBAS as perguntas caem abaixo do limiar —
 * conservador de propósito (#8418: "abaixo de um limiar (calibrar; começar
 * conservador)"): um item só é cortado se Jev tem baixa confiança tanto em
 * "é sobre IA" quanto em "interessa ao público" — exigir as DUAS reduz o
 * risco de cortar por só um eixo estar baixo (ex: um artigo genuinamente
 * sobre IA mas de nicho técnico ainda pode interessar via `about_ai` alto/
 * `audience_fit` baixo isolado; exigir ambos baixos é o corte mais cauteloso
 * possível dado o desenho de 2 perguntas da issue).
 */
export async function evaluatePoolRelevance(
  candidates: PoolCandidate[],
  opts: { apiKey: string; threshold: number; cacheDir?: string | null; fetchImpl?: typeof fetch },
): Promise<{ results: PoolRelevanceResult[]; errors: Map<string, unknown> }> {
  const questions = [POOL_RELEVANCE_8418_ABOUT_AI.question, POOL_RELEVANCE_8418_AUDIENCE_FIT.question];
  const { results: jevResults, errors } = await askJevBatch(
    candidates.map((c) => ({
      id: c.id,
      state: { title: c.title, url: c.url, summary: c.summary },
      questions,
      cacheKey: c.id,
    })),
    { apiKey: opts.apiKey, cacheDir: opts.cacheDir, fetchImpl: opts.fetchImpl },
  );
  const byId = new Map(jevResults.map((r) => [r.id, r.answers]));

  const results: PoolRelevanceResult[] = candidates.map((c) => {
    const answers = byId.get(c.id);
    const aboutAi = answers?.find((a) => a.id === "about_ai") as JevNoulAnswer | undefined;
    const audienceFit = answers?.find((a) => a.id === "audience_fit") as JevNoulAnswer | undefined;
    const probAboutAi = aboutAi?.probability ?? null;
    const probAudienceFit = audienceFit?.probability ?? null;
    const poolFiltered =
      probAboutAi === null || probAudienceFit === null
        ? null
        : probAboutAi < opts.threshold && probAudienceFit < opts.threshold;
    return { id: c.id, edition: c.edition, decision: c.decision, probAboutAi, probAudienceFit, poolFiltered };
  });

  return { results, errors };
}

export function renderReport(
  candidates: PoolCandidate[],
  results: PoolRelevanceResult[],
  errorCount: number,
  threshold: number,
  runLabel?: string,
): string {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const n = results.length;
  const withJev = results.filter((r) => r.poolFiltered !== null);
  const filtered = withJev.filter((r) => r.poolFiltered === true);
  const falsePositivesGrave = filtered.filter((r) => r.decision === "aprovado");
  const trueDiscards = filtered.filter((r) => r.decision === "descartado");

  const lines: string[] = [];
  lines.push(`# Jev eval — pool-relevance (#8418)${runLabel ? ` (${runLabel})` : ""}`);
  lines.push("");
  lines.push(
    `n=${n} candidato(s), limiar=${threshold} (filtrado quando about_ai E audience_fit < limiar)` +
      `${errorCount > 0 ? `, ${errorCount} falha(s) de transporte excluída(s)` : ""}`,
  );
  lines.push("");
  lines.push(`| decisão editorial | n |`);
  lines.push(`|---|---|`);
  lines.push(`| aprovado (destaque/pool final) | ${candidates.filter((c) => c.decision === "aprovado").length} |`);
  lines.push(`| descartado (nunca usado) | ${candidates.filter((c) => c.decision === "descartado").length} |`);
  lines.push("");
  lines.push(`**Jev filtraria ${filtered.length}/${withJev.length} candidato(s) avaliado(s):**`);
  lines.push("");
  lines.push(`- falso-positivo GRAVE (aprovado, mas seria filtrado): **${falsePositivesGrave.length}**`);
  lines.push(`- corte correto (descartado, e seria filtrado): ${trueDiscards.length}`);
  lines.push("");
  if (falsePositivesGrave.length > 0) {
    lines.push(`**Falsos-positivos graves:**`);
    lines.push("");
    for (const r of falsePositivesGrave) {
      const c = byId.get(r.id)!;
      lines.push(
        `- [${c.edition}] about_ai=${r.probAboutAi?.toFixed(2)}, audience_fit=${r.probAudienceFit?.toFixed(2)} — ${c.title.slice(0, 90)} (${c.url})`,
      );
    }
    lines.push("");
  }

  // Nota: McNemar (scripts/lib/mcnemar.ts) NÃO se aplica aqui de propósito —
  // ele compara dois classificadores que cada um tem "acerto"/"erro" bem
  // definido contra um rótulo. O "mecanismo atual" desta medição nunca
  // filtra nada (todo candidato categorizado entra no pool), então não tem
  // opinião pareável contra a de Jev — a comparação pareada relevante é o
  // falso-positivo grave já reportado acima, não um teste de discordância.

  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const rootArg = getStringArg(argv, "root");
  const rootDir = rootArg ? resolve(rootArg) : SELF_ROOT;
  loadProjectEnv(rootDir);
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    console.error("TYPESAFE_API_KEY ausente — sem key não há como consultar Jev pra comparação.");
    process.exit(2);
  }
  const threshold = (getIntArg(argv, "threshold-pct", { min: 0, max: 100 }) ?? 30) / 100;
  const runs = getIntArg(argv, "runs", { min: 1 }) ?? 1;
  const limit = getIntArg(argv, "limit", { min: 1 });
  const cacheDirArg = getStringArg(argv, "cache-dir");
  const editionsArg = getStringArg(argv, "editions");
  const editionsFilter = editionsArg ? editionsArg.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  const { candidates: allCandidates, skipped } = collectPoolRelevanceCandidates(rootDir, editionsFilter);
  if (skipped.length > 0) {
    console.warn(`${skipped.length} edição(ões) ilegível(is), fora do pool:`);
    for (const s of skipped) console.warn(`  ${s}`);
  }
  if (allCandidates.length === 0) {
    console.error(`nenhum candidato encontrado sob ${rootDir}/data/editions — passe --root apontando pro checkout com o corpus.`);
    process.exit(2);
  }
  const candidates = limit ? allCandidates.slice(0, limit) : allCandidates;
  console.log(`pool: ${allCandidates.length} candidato(s) em ${new Set(allCandidates.map((c) => c.edition)).size} edição(ões)${limit ? ` (avaliando ${candidates.length})` : ""}`);
  console.log("");

  for (let run = 1; run <= runs; run++) {
    const cacheDir = runs > 1 ? null : (cacheDirArg ?? resolve(rootDir, "data", "jev-eval", "pool-relevance-8418", "cache"));
    try {
      const { results, errors } = await evaluatePoolRelevance(candidates, { apiKey, threshold, cacheDir });
      console.log(renderReport(candidates, results, errors.size, threshold, runs > 1 ? `run ${run}/${runs}` : undefined));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
