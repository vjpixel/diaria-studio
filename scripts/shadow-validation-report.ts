#!/usr/bin/env tsx
/**
 * scripts/shadow-validation-report.ts (#7977, Camada 2 shadow-mode da #7972)
 *
 * Relatório read-only: responde "o `shadow_score_alt` de um candidato de
 * pesos prediz a decisão do editor (`kept`) tão bem quanto o `score` real
 * prediz, em dados que NENHUM dos dois viu treinar?" — sem calibrar nada,
 * sem escrever em produção.
 *
 * Métrica: CONCORDÂNCIA DE RANKING, não reprodução de valor absoluto (ver
 * correção de premissa em `scripts/lib/shadow-score.ts` — `shadow_score_alt`
 * nunca bate com `score` real linha a linha, porque não modela
 * impact_routine/coverage/audience_affinity; a pergunta certa é se ele
 * RANQUEIA igual, não se ele REPRODUZ o número). Operacionalizada como AUC
 * (Mann-Whitney): pra cada edição, sobre todos os pares (item mantido, item
 * descartado), a fração de pares em que o item mantido tem score MAIOR
 * (empate conta 0.5) — 0.5 = sem poder preditivo, 1.0 = separação perfeita.
 * Calculada separadamente pro `score` real e pro `shadow_score_alt`, edição
 * por edição, depois agregada (média) sobre a janela de holdout.
 *
 * Holdout (#7972, correção de escopo do comentário de 11/09/2026): as ~25
 * edições mais recentes que tenham os 3 arquivos necessários
 * (scoring-features.json, scoring-shadow.json, 01-approved.json) —
 * cronologicamente as últimas, nunca uma amostra aleatória, porque o
 * candidato de baseline (`340ec6d9d3e9b0f1.json`) foi só LIDO do rubrico
 * real, nunca ajustado a nenhum dado — não há vazamento de treino a evitar
 * na escolha de QUAL parte do corpus vira holdout, mas manter cronológico
 * agora é o hábito certo pra quando `calibrate-scoring-weights.ts` (#7990)
 * existir e passar a ajustar pesos a partir do resto do corpus.
 *
 * `kept` reusa a mesma definição de `calibration-power-report.ts`
 * (`keptUrlsFromApproved`): URL presente em QUALQUER bucket de
 * `01-approved.json`, incluindo `highlights`.
 *
 * Concentração de fonte (HHI, `scripts/lib/source-concentration.ts`):
 * reportada por edição sobre os itens MANTIDOS (kept=true) — mitigação S-6
 * da #7972, "candidato cujo suporte de evidência está concentrado numa
 * fonte/domínio é suspeito". Leitura, não gate — nenhum candidato é
 * rejeitado automaticamente aqui; o número fica no relatório pra quem
 * revisar o candidato decidir.
 *
 * Uso:
 *   npx tsx scripts/shadow-validation-report.ts --weights <hash> [--editions-dir DIR] [--holdout N] [--json]
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { computeDomainConcentration, type DomainConcentration } from "./lib/source-concentration.ts";
import type { ScoringFeatureRow } from "./lib/scoring-features.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_HOLDOUT = 25;

interface ShadowRow {
  url: string;
  bucket: string;
  score: number | null;
  shadow_score_alt: number | null;
}

/** Mesma definição de `calibration-power-report.ts` — URL em qualquer bucket de `01-approved.json`, highlights incluído. */
function keptUrlsFromApproved(json: any): Set<string> {
  const urls = new Set<string>();
  const buckets = ["highlights", "runners_up", "lancamento", "radar", "use_melhor", "video"];
  for (const bucket of buckets) {
    for (const item of json?.[bucket] ?? []) {
      const url = item?.article?.url ?? item?.url;
      if (typeof url === "string" && url !== "") urls.add(url);
    }
  }
  return urls;
}

/**
 * AUC (Mann-Whitney U / n_pos*n_neg) de `values` prevendo `labels` — fração
 * de pares (positivo, negativo) em que o valor do positivo é maior (empate
 * conta 0.5). `null` se um dos dois grupos estiver vazio ou todo valor for
 * `null` (métrica indefinida, nunca fabricada como 0 ou 0.5).
 */
export function computeAuc(values: ReadonlyArray<number | null>, labels: ReadonlyArray<boolean>): number | null {
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) continue;
    if (labels[i]) pos.push(v);
    else neg.push(v);
  }
  if (pos.length === 0 || neg.length === 0) return null;

  let wins = 0;
  for (const p of pos) {
    for (const n of neg) {
      if (p > n) wins += 1;
      else if (p === n) wins += 0.5;
    }
  }
  return wins / (pos.length * neg.length);
}

export interface EditionValidation {
  edition: string;
  n_rows: number;
  n_kept: number;
  auc_real: number | null;
  auc_shadow: number | null;
  kept_domain_concentration: DomainConcentration;
}

export interface ShadowValidationResult {
  candidate_weights_hash: string;
  holdout_requested: number;
  holdout_editions: EditionValidation[];
  /** Edições candidatas (têm scoring-features.json) mas faltando scoring-shadow.json (deste candidato) ou 01-approved.json. */
  editions_skipped: Array<{ edition: string; reason: string }>;
  mean_auc_real: number | null;
  mean_auc_shadow: number | null;
  /** Nº de edições em que cada AUC pôde ser calculada — os dois denominadores podem divergir (uma edição pode ter shadow mas não score real utilizável, ou vice-versa). */
  editions_with_auc_real: number;
  editions_with_auc_shadow: number;
}

function mean(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function buildShadowValidationReport(
  editionsRoot: string,
  weightsHash: string,
  holdout = DEFAULT_HOLDOUT,
): ShadowValidationResult {
  const editionDirs = enumerateEditionDirs(editionsRoot);
  const allEditions = [...editionDirs.entries()].sort(([a], [b]) => a.localeCompare(b));

  // Candidatas: têm scoring-features.json (pré-requisito de todo o resto).
  // Cronologicamente as últimas `holdout` dentre as candidatas — não dentre
  // TODAS as edições (uma edição sem features nunca é holdout válido).
  const candidates = allEditions.filter(([, dir]) => existsSync(join(dir, "_internal", "scoring-features.json")));
  const holdoutSet = candidates.slice(-holdout);

  const results: EditionValidation[] = [];
  const skipped: Array<{ edition: string; reason: string }> = [];

  for (const [edition, dir] of holdoutSet) {
    const featuresPath = join(dir, "_internal", "scoring-features.json");
    const shadowPath = join(dir, "_internal", "scoring-shadow.json");
    const approvedPath = join(dir, "_internal", "01-approved.json");

    if (!existsSync(shadowPath)) {
      skipped.push({ edition, reason: "scoring-shadow.json ausente — rodar compute-shadow-scores.ts pra este candidato primeiro" });
      continue;
    }
    if (!existsSync(approvedPath)) {
      skipped.push({ edition, reason: "01-approved.json ausente — impossível derivar kept" });
      continue;
    }

    try {
      const featuresPayload = JSON.parse(readFileSync(featuresPath, "utf8"));
      const shadowPayload = JSON.parse(readFileSync(shadowPath, "utf8"));
      const approvedJson = JSON.parse(readFileSync(approvedPath, "utf8"));

      if (shadowPayload?.candidate_weights_hash !== weightsHash) {
        skipped.push({
          edition,
          reason: `scoring-shadow.json existe mas foi calculado com outro candidato (${shadowPayload?.candidate_weights_hash ?? "desconhecido"}, não ${weightsHash}) — rodar compute-shadow-scores.ts --force com o hash certo`,
        });
        continue;
      }

      const featureRows: ScoringFeatureRow[] = Array.isArray(featuresPayload?.rows) ? featuresPayload.rows : [];
      const shadowRows: ShadowRow[] = Array.isArray(shadowPayload?.rows) ? shadowPayload.rows : [];
      if (featureRows.length === 0 || shadowRows.length === 0) {
        skipped.push({ edition, reason: "scoring-features.json ou scoring-shadow.json sem rows" });
        continue;
      }

      const keptUrls = keptUrlsFromApproved(approvedJson);
      const shadowByUrl = new Map(shadowRows.map((r) => [r.url, r]));

      const realScores: Array<number | null> = [];
      const shadowScores: Array<number | null> = [];
      const labels: boolean[] = [];
      const keptDomains: Array<string | null> = [];
      let nKept = 0;

      for (const row of featureRows) {
        const kept = keptUrls.has(row.url);
        labels.push(kept);
        realScores.push(row.score);
        shadowScores.push(shadowByUrl.get(row.url)?.shadow_score_alt ?? null);
        if (kept) {
          nKept++;
          keptDomains.push(row.domain);
        }
      }

      results.push({
        edition,
        n_rows: featureRows.length,
        n_kept: nKept,
        auc_real: computeAuc(realScores, labels),
        auc_shadow: computeAuc(shadowScores, labels),
        kept_domain_concentration: computeDomainConcentration(keptDomains),
      });
    } catch (err) {
      skipped.push({ edition, reason: err instanceof SyntaxError ? `JSON malformado: ${err.message}` : `erro de leitura/I-O: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  const aucRealValues = results.map((r) => r.auc_real).filter((v): v is number => v !== null);
  const aucShadowValues = results.map((r) => r.auc_shadow).filter((v): v is number => v !== null);

  return {
    candidate_weights_hash: weightsHash,
    holdout_requested: holdout,
    holdout_editions: results,
    editions_skipped: skipped,
    mean_auc_real: mean(aucRealValues),
    mean_auc_shadow: mean(aucShadowValues),
    editions_with_auc_real: aucRealValues.length,
    editions_with_auc_shadow: aucShadowValues.length,
  };
}

function formatReport(report: ShadowValidationResult): string {
  const lines: string[] = [];
  lines.push(`[shadow-validation-report] candidato ${report.candidate_weights_hash} — holdout solicitado: ${report.holdout_requested} edições mais recentes`);
  lines.push(`  avaliadas: ${report.holdout_editions.length}  puladas: ${report.editions_skipped.length}`);
  if (report.editions_skipped.length > 0) {
    for (const s of report.editions_skipped) lines.push(`    PULADA ${s.edition}: ${s.reason}`);
  }
  lines.push("");
  lines.push(
    `  AUC média (kept vs score real): ${report.mean_auc_real !== null ? report.mean_auc_real.toFixed(3) : "n/d"} (${report.editions_with_auc_real} edições)`,
  );
  lines.push(
    `  AUC média (kept vs shadow_score_alt): ${report.mean_auc_shadow !== null ? report.mean_auc_shadow.toFixed(3) : "n/d"} (${report.editions_with_auc_shadow} edições)`,
  );
  lines.push("  (0.5 = sem poder preditivo, 1.0 = separação perfeita entre mantido/descartado; comparar os dois números, não julgar 1 isolado)");
  lines.push("");
  for (const e of report.holdout_editions) {
    const hhi = e.kept_domain_concentration;
    lines.push(
      `  ${e.edition}: n=${e.n_rows} kept=${e.n_kept}  auc_real=${e.auc_real?.toFixed(3) ?? "n/d"}  auc_shadow=${e.auc_shadow?.toFixed(3) ?? "n/d"}  HHI(kept)=${hhi.hhi.toFixed(0)} (top=${hhi.top_domain ?? "n/d"} ${(hhi.top_domain_share * 100).toFixed(0)}%)`,
    );
  }
  return lines.join("\n");
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const editionsRoot = resolve(ROOT, values["editions-dir"] ?? "data/editions");
  const weightsHash = values["weights"];
  const holdout = values["holdout"] ? Number(values["holdout"]) : DEFAULT_HOLDOUT;
  const json = process.argv.includes("--json");

  if (!weightsHash) {
    console.error("Uso: shadow-validation-report.ts --weights <hash> [--editions-dir DIR] [--holdout N] [--json]");
    process.exit(2);
  }
  if (!Number.isInteger(holdout) || holdout <= 0) {
    console.error(`--holdout precisa ser um inteiro positivo, recebido: ${values["holdout"]}`);
    process.exit(2);
  }

  const report = buildShadowValidationReport(editionsRoot, weightsHash, holdout);
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
}
