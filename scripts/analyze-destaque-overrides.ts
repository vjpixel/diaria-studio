#!/usr/bin/env tsx
/**
 * scripts/analyze-destaque-overrides.ts (#7976, Camada 2 da #7972)
 *
 * @one-off-validity: permanente motivo="infraestrutura recorrente da calibração de score — consumida por calibrate-scoring-weights.ts (Fase 2, #7976) e re-rodada a cada nova rodada de calibração, não uma análise ad-hoc de uma vez"
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
 * TRACK B — movimentação de bucket do pool. Índice PRÓPRIO dos 4 buckets
 * (`lancamento`/`radar`/`use_melhor`/`video`) — NÃO reusa `diffBucketOverrides`
 * de `scripts/analyze-bucket-overrides.ts`: aquela função exclui `video` de
 * propósito (#5995, escopo daquele script), o que deixaria qualquer
 * transição envolvendo `video` invisível ao diff e mal-rotulada como
 * `bucket_kept` (achado de review do #7976, corrigido antes do merge):
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
import type { CategorizedBucketsInput, ApprovedBucketsInput } from "./analyze-bucket-overrides.ts";
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
  // Carrega sinal REAL só quando track_a === llm_finalist_rejected_by_editor
  // (distingue "rebaixado" de "cortado da edição"). Nos eventos de Track B é
  // sempre redundante com o próprio track_b (true pra bucket_kept/
  // bucket_moved/pool_add, == !cut pra pool_cut) — redundante, não arbitrário.
  survived_in_pool: boolean;
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

const POOL_BUCKETS = ["lancamento", "radar", "use_melhor", "video"] as const;

function poolUrls(json: any): Set<string> {
  const urls = new Set<string>();
  for (const bucket of POOL_BUCKETS) {
    for (const item of json?.[bucket] ?? []) {
      if (typeof item?.url === "string" && item.url !== "") urls.add(item.url);
    }
  }
  return urls;
}

/**
 * URL → {bucket, title} pros 4 buckets do pool (achado de review do #7976:
 * `diffBucketOverrides`/`TRACKED_BUCKETS` de `analyze-bucket-overrides.ts`
 * exclui `video` DE PROPÓSITO — #5995, escopo próprio daquele script — mas
 * `poolUrls()` acima inclui os 4. Reusar `diffBucketOverrides` pra detectar
 * bucket-move aqui deixava toda transição envolvendo `video`
 * (`video→radar`/`radar→video`) invisível pro diff, e o item caía no loop
 * de sobra como `bucket_kept` — errado, era `bucket_moved`. Índice PRÓPRIO,
 * cobrindo os mesmos 4 buckets que `poolUrls()` já usa, evita depender de
 * uma função com escopo de buckets deliberadamente mais estreito.
 */
function poolIndexByUrl(json: any): Map<string, { bucket: string; title: string }> {
  const map = new Map<string, { bucket: string; title: string }>();
  for (const bucket of POOL_BUCKETS) {
    for (const item of json?.[bucket] ?? []) {
      if (typeof item?.url === "string" && item.url !== "") {
        map.set(item.url, { bucket, title: typeof item?.title === "string" ? item.title : "" });
      }
    }
  }
  return map;
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

  // --- Track B: pool (bucket-move, kept, cut, add) — índice PRÓPRIO dos 4
  // buckets (ver docstring de `poolIndexByUrl`), nunca `diffBucketOverrides`
  // (escopo de 3 buckets, exclui `video` de propósito noutro script).
  const catPoolIndex = poolIndexByUrl(categorizedJson);
  const apprPoolIndex = poolIndexByUrl(approvedJson as any);

  for (const [url, catEntry] of catPoolIndex) {
    // já contado: era destaque no categorized (Track A cobre), OU foi
    // promovido a destaque no approved (Track A cobre como
    // editor_promoted_outside_llm_finalists — "some" do pool porque virou
    // destaque, não porque foi cortado).
    if (catHighlights.has(url) || apprHighlights.has(url)) continue;
    const apprEntry = apprPoolIndex.get(url);
    if (apprEntry) {
      events.push({
        edition,
        url,
        title: apprEntry.title || catEntry.title,
        track_b: apprEntry.bucket === catEntry.bucket ? "bucket_kept" : "bucket_moved",
        bucket_move: apprEntry.bucket === catEntry.bucket ? undefined : { from: catEntry.bucket, to: apprEntry.bucket },
        survived_in_pool: true,
        features: featuresByUrl.get(url) ?? null,
      });
    } else {
      events.push({
        edition,
        url,
        title: catEntry.title,
        track_b: "pool_cut",
        survived_in_pool: false,
        features: featuresByUrl.get(url) ?? null,
      });
    }
  }
  for (const [url, apprEntry] of apprPoolIndex) {
    if (catPoolIndex.has(url) || catHighlights.has(url)) continue; // não é genuinamente novo
    events.push({
      edition,
      url,
      title: apprEntry.title,
      track_b: "pool_add",
      survived_in_pool: true,
      features: featuresByUrl.get(url) ?? null,
    });
  }

  return events;
}

export interface AnalyzeAllResult {
  editions_analyzed: number;
  /** Edições candidatas (têm 01-categorized.json + 01-approved.json) puladas mesmo assim por dado malformado/erro de leitura — nunca silencioso (achado de review do #7976, mesma correção de calibration-power-report.ts). */
  editions_skipped: Array<{ edition: string; reason: string }>;
  events: LabeledEvent[];
  events_missing_features: number; // eventos cuja URL não bateu em scoring-features.json (edição sem backfill, ou artigo removido antes do Stage 1 salvar o feature store)
}

export function analyzeAllEditions(editionsRoot: string): AnalyzeAllResult {
  const editionDirs = enumerateEditionDirs(editionsRoot);
  const events: LabeledEvent[] = [];
  const skipped: Array<{ edition: string; reason: string }> = [];
  let editionsAnalyzed = 0;
  for (const [edition, dir] of [...editionDirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const catPath = join(dir, "_internal", "01-categorized.json");
    const apprPath = join(dir, "_internal", "01-approved.json");
    const featPath = join(dir, "_internal", "scoring-features.json");
    if (!existsSync(catPath) || !existsSync(apprPath)) continue; // candidata nem existe — não é "pulada", nunca foi elegível
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
    } catch (err) {
      // Achado de review do #7976: catch sem discriminação escondia erro de
      // I/O real (permissão, OneDrive travado) sob o mesmo rótulo de "JSON
      // malformado" — nunca aparecia em lugar nenhum. Sempre registrado.
      const reason = err instanceof SyntaxError ? `JSON malformado: ${err.message}` : `erro de leitura/I-O: ${err instanceof Error ? err.message : String(err)}`;
      skipped.push({ edition, reason });
      continue;
    }
  }
  const missingFeatures = events.filter((e) => e.features === null).length;
  return { editions_analyzed: editionsAnalyzed, editions_skipped: skipped, events, events_missing_features: missingFeatures };
}

function summarize(result: AnalyzeAllResult): string {
  const lines: string[] = [];
  lines.push(`[analyze-destaque-overrides] ${result.editions_analyzed} edições analisadas, ${result.events.length} eventos rotulados.`);
  if (result.editions_skipped.length > 0) {
    lines.push(`  ${result.editions_skipped.length} edição(ões) candidata(s) PULADA(S) (dado malformado/erro de leitura):`);
    for (const s of result.editions_skipped) lines.push(`    ${s.edition}: ${s.reason}`);
  }
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
