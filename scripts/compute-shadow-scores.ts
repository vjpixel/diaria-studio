#!/usr/bin/env tsx
/**
 * scripts/compute-shadow-scores.ts (#7977, Camada 2 shadow-mode da #7972)
 *
 * @one-off-validity: permanente motivo="infraestrutura recorrente do shadow-mode — roda a cada rodada de validação de candidato de calibração, não é análise de uma vez"
 *
 * Grava `_internal/scoring-shadow.json` pra cada edição que já tenha
 * `scoring-features.json` (#7975) — nunca modifica/apaga arquivo existente,
 * só escreve o novo. TS puro, zero chamada de LLM, zero efeito no score
 * real ou na seleção de qualquer edição (mesma garantia de
 * `backfill-scoring-features.ts`).
 *
 * IMPORTANTE — decisão de escopo (correção de premissa em relação ao
 * texto original da #7977): o design pedia gravar `shadow_score_alt`
 * DENTRO do fluxo ao vivo (`scorer-chunk`/`merge-scored-chunks.ts`, os
 * scripts que a edição do dia realmente usa). Implementado aqui como
 * script STANDALONE pós-hoc em vez disso — mesmo padrão de
 * `backfill-scoring-features.ts` — por 2 motivos: (1) o `/goal` desta
 * rodada proíbe explicitamente tocar a edição em curso (260912), e mexer
 * em `merge-scored-chunks.ts` arrisca exatamente isso se uma edição real
 * rodar enquanto o arquivo está sendo editado no checkout compartilhado;
 * (2) o script standalone já cobre 100% do propósito do shadow-mode (medir
 * concordância sem afetar produção) com risco zero — wiring no fluxo ao
 * vivo fica pra quando a Fase 4 (#7978, portão de sign-off) já existir e
 * puder gatear isso com segurança.
 *
 * Uso:
 *   npx tsx scripts/compute-shadow-scores.ts --all --weights <hash> [--editions-dir DIR] [--force]
 *   npx tsx scripts/compute-shadow-scores.ts --edition AAMMDD --weights <hash> [--force]
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { computeShadowScore, weightsHash, type CandidateWeightsFile } from "./lib/shadow-score.ts";
import type { ScoringFeatureRow } from "./lib/scoring-features.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CANDIDATE_WEIGHTS_DIR = resolve(ROOT, "context", "scoring", "candidate-weights");

export interface ShadowResult {
  edition: string;
  status: "written" | "skipped-exists" | "skipped-no-features" | "error";
  rows?: number;
  error?: string;
}

/** Lê e valida um arquivo de pesos candidato por hash — falha alto se o conteúdo não bater com o hash do nome do arquivo (proteção contra edição manual que esqueceu de recalcular). */
export function loadCandidateWeights(hash: string): CandidateWeightsFile {
  const path = join(CANDIDATE_WEIGHTS_DIR, `${hash}.json`);
  if (!existsSync(path)) {
    throw new Error(`Arquivo de pesos candidato não encontrado: ${path}. Rodar com --list-weights pra ver os disponíveis.`);
  }
  const file: CandidateWeightsFile = JSON.parse(readFileSync(path, "utf8"));
  const actualHash = weightsHash(file.weights);
  if (actualHash !== hash) {
    throw new Error(
      `Hash do arquivo ${path} não bate com o conteúdo (esperado ${hash}, calculado ${actualHash}) — o arquivo de pesos foi editado sem recalcular o hash. Nunca use um candidato com hash inconsistente.`,
    );
  }
  return file;
}

export function listCandidateWeightHashes(): string[] {
  if (!existsSync(CANDIDATE_WEIGHTS_DIR)) return [];
  return readdirSync(CANDIDATE_WEIGHTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

function processEdition(editionDir: string, edition: string, weightsHashValue: string, weights: CandidateWeightsFile["weights"], force: boolean): ShadowResult {
  const featuresPath = join(editionDir, "_internal", "scoring-features.json");
  if (!existsSync(featuresPath)) return { edition, status: "skipped-no-features" };

  const outPath = join(editionDir, "_internal", "scoring-shadow.json");
  if (existsSync(outPath) && !force) return { edition, status: "skipped-exists" };

  try {
    const payload = JSON.parse(readFileSync(featuresPath, "utf8"));
    const rows: ScoringFeatureRow[] = Array.isArray(payload?.rows) ? payload.rows : [];
    const shadowRows = rows.map((row) => ({
      url: row.url,
      bucket: row.bucket,
      score: row.score,
      shadow_score_alt: computeShadowScore(row, weights),
    }));
    const out = {
      edition,
      generated_at: new Date().toISOString(),
      candidate_weights_hash: weightsHashValue,
      row_count: shadowRows.length,
      rows: shadowRows,
    };
    writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
    return { edition, status: "written", rows: shadowRows.length };
  } catch (err) {
    return { edition, status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

export function runComputeShadowScores(
  editionsRoot: string,
  opts: { edition?: string; weightsHash: string; force: boolean },
): ShadowResult[] {
  const file = loadCandidateWeights(opts.weightsHash);
  const editionDirs = enumerateEditionDirs(editionsRoot);
  const targets: Array<[string, string]> = opts.edition
    ? editionDirs.has(opts.edition)
      ? [[opts.edition, editionDirs.get(opts.edition)!]]
      : []
    : [...editionDirs.entries()].sort(([a], [b]) => a.localeCompare(b));

  return targets.map(([edition, dir]) => processEdition(dir, edition, opts.weightsHash, file.weights, opts.force));
}

if (isMainModule(import.meta.url)) {
  const { flags, values } = parseArgs(process.argv.slice(2));

  if (flags.has("list-weights")) {
    const hashes = listCandidateWeightHashes();
    for (const h of hashes) {
      const f = loadCandidateWeights(h);
      console.log(`${h}  ${f.label}  (${Object.keys(f.weights).length} features)`);
    }
    process.exit(0);
  }

  const editionsRoot = resolve(ROOT, values["editions-dir"] ?? "data/editions");
  const edition = values["edition"];
  const weightsHashArg = values["weights"];
  const all = flags.has("all");
  const force = flags.has("force");

  if (!weightsHashArg) {
    console.error("Uso: compute-shadow-scores.ts --all|--edition AAMMDD --weights <hash> [--editions-dir DIR] [--force] | --list-weights");
    process.exit(2);
  }
  if (!edition && !all) {
    console.error("Uso: compute-shadow-scores.ts --all|--edition AAMMDD --weights <hash> [--editions-dir DIR] [--force]");
    process.exit(2);
  }

  try {
    const results = runComputeShadowScores(editionsRoot, { edition, weightsHash: weightsHashArg, force });
    const byStatus: Record<string, number> = {};
    for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    console.log(`[compute-shadow-scores] ${results.length} edições processadas — ${JSON.stringify(byStatus)}`);
    for (const r of results) {
      if (r.status === "error") console.error(`  ERRO ${r.edition}: ${r.error}`);
    }
    process.exit(results.some((r) => r.status === "error") ? 1 : 0);
  } catch (err) {
    console.error("[compute-shadow-scores] falha:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
