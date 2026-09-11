#!/usr/bin/env tsx
/**
 * scripts/analyze-destaque-overrides.ts (#7976, Camada 2 da #7972)
 *
 * Junta `scoring-features.json` (features determinísticas por candidato,
 * #7975) com o diff `01-categorized.json` × `01-approved.json` de cada
 * edição, rotulando cada candidato do pool inteiro (não só destaques) num
 * dos rótulos abaixo — a base de exemplos rotulados pra `calibrate-
 * scoring-weights.ts` (ainda não escrito) treinar sobre.
 *
 * Read-only: não escreve em nenhum arquivo, não afeta score/seleção real
 * de nenhuma edição.
 *
 * TRACK A — seleção de destaque (`01-categorized.json.highlights` é a
 * escolha do LLM `scorer-select`, sempre 6, ANTES de qualquer edição
 * humana; `01-approved.json.highlights` é o que o editor de fato aprovou,
 * 2-3):
 *   - `llm_finalist_and_approved` — o LLM escolheu como um dos 6, o editor
 *     manteve como destaque.
 *   - `llm_finalist_rejected_by_editor` — o LLM escolheu, o editor NÃO
 *     manteve como destaque (pode ter sobrevivido rebaixado ao pool, ou
 *     sido cortado da edição inteira — ver `survived_in_pool`).
 *   - `editor_promoted_outside_llm_finalists` — o editor promoveu a
 *     destaque um candidato que o LLM NUNCA tinha escolhido como um dos 6.
 *
 * TRACK B — movimentação de bucket do pool (reusa `diffBucketOverrides` de
 * `scripts/analyze-bucket-overrides.ts`, mesma lógica já validada contra o
 * corpus real):
 *   - `bucket_kept` — mesma URL, mesmo bucket nos dois lados.
 *   - `bucket_moved` — mesma URL, bucket diferente (ver `bucket_move` no
 *     evento pra saber de/pra onde).
 *   - `pool_cut` — saiu do pool sem virar destaque.
 *   - `pool_add` — apareceu no pool aprovado sem estar no categorizado
 *     (tipicamente resgatado de `runners_up`).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { diffBucketOverrides, type CategorizedBucketsInput, type ApprovedBucketsInput, type BucketMove } from "./analyze-bucket-overrides.ts";
import type { ScoringFeatureRow } from "./lib/scoring-features.ts";

const ROOT = resolve(import.meta.dirname, "..");

export type TrackALabel = "llm_finalist_and_approved" | "llm_finalist_rejected_by_editor" | "editor_promoted_outside_llm_finalists";
export type TrackBLabel = "bucket_kept" | "bucket_moved" | "pool_cut" | "pool_add";

export interface LabeledEvent {
  edition: string;
  url: string;
  title: string;
  track_a?: TrackALabel;
  track_b?: TrackBLabel;
  bucket_move?: { from: string; to: string };
  survived_in_pool: boolean; // (só relevante quando track_a === llm_finalist_rejected_by_editor)
  features: ScoringFeatureRow | null; // null se a URL não aparecer em scoring-features.json (dado faltando pra essa edição/artigo)
}

function highlightUrls(json: any): Map<string, string> {
  const map = new Map<string, string>();
  for (const h of json?.highlights ?? []) {
    const url = h?.article?.url ?? h?.url;
    const title = h?.article?.title ?? h?.title ?? "";
    if (typeof url === "string" && url !== "") map.set(url, title);
  }
  return map;
}

function poolUrls(json: any): Set<string> {
  const urls = new Set<string>();
  for (const bucket of ["lancamento", "radar", "use_melhor", "video"]) {
    for (const item of json?.[bucket] ?? []) {
      if (typeof item?.url === "string" && item.url !== "") urls.add(item.url);
    }
  }
  return urls;
}

/** Analisa 1 edição — puro, sem I/O (recebe os 3 JSONs já parseados). */
export function analyzeEditionOverrides(
  edition: string,
  categorizedJson: CategorizedBucketsInput,
  approvedJson: ApprovedBucketsInput,
  featureRows: ScoringFeatureRow[],
): LabeledEvent[] {
  const featuresByUrl = new Map(featureRows.map((r) => [r.url, r]));
  const events: LabeledEvent[] = [];
  const seen = new Set<string>();

  // --- Track A: destaques ---
  const catHighlights = highlightUrls(categorizedJson);
  const apprHighlights = highlightUrls(approvedJson as any);
  const apprPool = poolUrls(approvedJson as any);

  for (const [url, title] of catHighlights) {
    seen.add(url);
    const approvedTitle = apprHighlights.get(url);
    events.push({
      edition,
      url,
      title: approvedTitle ?? title,
      track_a: apprHighlights.has(url) ? "llm_finalist_and_approved" : "llm_finalist_rejected_by_editor",
      survived_in_pool: !apprHighlights.has(url) && apprPool.has(url),
      features: featuresByUrl.get(url) ?? null,
    });
  }
  for (const [url, title] of apprHighlights) {
    if (seen.has(url)) continue; // já coberto acima (llm_finalist_and_approved)
    seen.add(url);
    events.push({
      edition,
      url,
      title,
      track_a: "editor_promoted_outside_llm_finalists",
      survived_in_pool: false,
      features: featuresByUrl.get(url) ?? null,
    });
  }

  // --- Track B: pool (bucket-move, cut, add) reusando diffBucketOverrides ---
  const moves = diffBucketOverrides(categorizedJson, approvedJson);
  const movedUrls = new Set(moves.map((m) => m.url));
  for (const move of moves) {
    events.push({
      edition,
      url: move.url,
      title: move.title,
      track_b: "bucket_moved",
      bucket_move: { from: move.from, to: move.to },
      survived_in_pool: true,
      features: featuresByUrl.get(move.url) ?? null,
    });
  }

  const catPool = poolUrls(categorizedJson as any);
  for (const url of catPool) {
    // já contado: bucket_moved, era destaque no categorized (Track A cobre),
    // OU foi promovido a destaque no approved (Track A cobre como
    // editor_promoted_outside_llm_finalists — "some" do pool porque virou
    // destaque, não porque foi cortado).
    if (movedUrls.has(url) || catHighlights.has(url) || apprHighlights.has(url)) continue;
    const kept = apprPool.has(url);
    events.push({
      edition,
      url,
      title: "",
      track_b: kept ? "bucket_kept" : "pool_cut",
      survived_in_pool: kept,
      features: featuresByUrl.get(url) ?? null,
    });
  }
  for (const url of apprPool) {
    if (catPool.has(url) || movedUrls.has(url) || catHighlights.has(url)) continue; // não é genuinamente novo
    events.push({
      edition,
      url,
      title: "",
      track_b: "pool_add",
      survived_in_pool: true,
      features: featuresByUrl.get(url) ?? null,
    });
  }

  return events;
}

export interface AnalyzeAllResult {
  editions_analyzed: number;
  events: LabeledEvent[];
  events_missing_features: number; // eventos cuja URL não bateu em scoring-features.json (edição sem backfill, ou artigo removido antes do Stage 1 salvar o feature store)
}

export function analyzeAllEditions(editionsRoot: string): AnalyzeAllResult {
  const editionDirs = enumerateEditionDirs(editionsRoot);
  const events: LabeledEvent[] = [];
  let editionsAnalyzed = 0;
  for (const [edition, dir] of [...editionDirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const catPath = join(dir, "_internal", "01-categorized.json");
    const apprPath = join(dir, "_internal", "01-approved.json");
    const featPath = join(dir, "_internal", "scoring-features.json");
    if (!existsSync(catPath) || !existsSync(apprPath)) continue;
    try {
      const categorizedJson = JSON.parse(readFileSync(catPath, "utf8"));
      const approvedJson = JSON.parse(readFileSync(apprPath, "utf8"));
      let featureRows: ScoringFeatureRow[] = [];
      if (existsSync(featPath)) {
        const payload = JSON.parse(readFileSync(featPath, "utf8"));
        if (Array.isArray(payload?.rows)) featureRows = payload.rows;
      }
      events.push(...analyzeEditionOverrides(edition, categorizedJson, approvedJson, featureRows));
      editionsAnalyzed++;
    } catch {
      continue; // edição com dado malformado — pula, não trava a análise inteira
    }
  }
  const missingFeatures = events.filter((e) => e.features === null).length;
  return { editions_analyzed: editionsAnalyzed, events, events_missing_features: missingFeatures };
}

function summarize(result: AnalyzeAllResult): string {
  const lines: string[] = [];
  lines.push(`[analyze-destaque-overrides] ${result.editions_analyzed} edições analisadas, ${result.events.length} eventos rotulados.`);
  if (result.events_missing_features > 0) {
    lines.push(
      `  ${result.events_missing_features} eventos SEM scoring-features.json correspondente (edição sem backfill rodado, ou o artigo não sobreviveu até o Stage 1 salvar o feature store) — features=null nesses, não contam pra calibração.`,
    );
  }
  const byLabel: Record<string, number> = {};
  for (const e of result.events) {
    const label = e.track_a ?? e.track_b ?? "?";
    byLabel[label] = (byLabel[label] ?? 0) + 1;
  }
  lines.push("");
  lines.push("Distribuição de rótulos:");
  for (const [label, count] of Object.entries(byLabel).sort(([, a], [, b]) => b - a)) {
    lines.push(`  ${label}: ${count}`);
  }
  return lines.join("\n");
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const editionsRoot = resolve(ROOT, values["editions-dir"] ?? "data/editions");
  const json = process.argv.includes("--json");
  const result = analyzeAllEditions(editionsRoot);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(summarize(result));
  }
}
