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
import { CANDIDATE_FEATURES } from "./calibration-power-report.ts";
import type { ScoringFeatureRow } from "./lib/scoring-features.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CANDIDATE_WEIGHTS_DIR = resolve(ROOT, "context", "scoring", "candidate-weights");
const KNOWN_CANDIDATE_FEATURES = new Set<string>(CANDIDATE_FEATURES);

export interface ShadowResult {
  edition: string;
  /**
   * `"written"` cobre tanto primeira escrita quanto `--force` sobre um
   * `scoring-shadow.json` pré-existente — achado de review do #7977: as
   * duas eram indistinguíveis no resumo do CLI, então um operador rodando
   * `--all --force` não tinha como saber quantas edições tiveram shadow
   * scores REESCRITOS (potencialmente descartando um candidato anterior)
   * vs. escritos pela primeira vez. `overwritten_previous_hash` carrega o
   * `candidate_weights_hash` do arquivo substituído quando esse for o caso
   * (`undefined` numa escrita genuinamente nova).
   */
  status: "written" | "skipped-exists" | "skipped-no-features" | "error" | "error-write";
  rows?: number;
  error?: string;
  overwritten_previous_hash?: string;
}

/**
 * Lê e valida um arquivo de pesos candidato por hash — falha alto se o
 * conteúdo não bater com o hash do nome do arquivo (proteção contra edição
 * manual que esqueceu de recalcular), E se alguma chave de `weights` não for
 * um nome de feature calibrável conhecido (`CANDIDATE_FEATURES` — achado de
 * review do #7977: sem esta checagem, uma chave com typo/nome obsoleto
 * contribuía peso 0 pra sempre, silenciosamente, num mecanismo cujo
 * propósito inteiro é comparar pesos com precisão).
 */
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
  const unknownKeys = Object.keys(file.weights).filter((k) => !KNOWN_CANDIDATE_FEATURES.has(k));
  if (unknownKeys.length > 0) {
    throw new Error(
      `Arquivo de pesos candidato ${path} tem chave(s) desconhecida(s): ${unknownKeys.join(", ")} — não batem com nenhuma feature de CANDIDATE_FEATURES (calibration-power-report.ts). Typo, ou feature renomeada/removida desde que este candidato foi criado? Uma chave inválida contribuiria peso 0 pra sempre, silenciosamente.`,
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
  const exists = existsSync(outPath);
  if (exists && !force) return { edition, status: "skipped-exists" };

  // Capturado ANTES de sobrescrever — achado de review do #7977: `--force`
  // reescrevendo um scoring-shadow.json pré-existente saía com o MESMO
  // status "written" que uma escrita genuinamente nova, então um operador
  // não tinha como saber, pelo resumo do CLI, quantas edições tiveram um
  // candidato anterior descartado. Captura best-effort (fail-soft — um
  // arquivo pré-existente corrompido não deveria bloquear a escrita nova).
  let overwrittenHash: string | undefined;
  if (exists && force) {
    try {
      overwrittenHash = JSON.parse(readFileSync(outPath, "utf8"))?.candidate_weights_hash;
    } catch {
      // Arquivo pré-existente ilegível/corrompido — segue sem o hash anterior, não bloqueia o --force.
    }
  }

  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(featuresPath, "utf8"));
  } catch (err) {
    // Fase de LEITURA — dado malformado numa edição específica. Status
    // distinto da fase de ESCRITA abaixo (achado de review do #7977, mesma
    // lição já aplicada em backfill-scoring-features.ts: misturar as duas
    // classes faz o operador investigar edição por edição em vez de
    // checar disco/permissão 1x quando o problema é de infra).
    return { edition, status: "error", error: err instanceof SyntaxError ? `JSON malformado: ${err.message}` : err instanceof Error ? err.message : String(err) };
  }

  const rawRows = (payload as { rows?: unknown })?.rows;
  if (rawRows !== undefined && !Array.isArray(rawRows)) {
    console.warn(`[compute-shadow-scores] ${edition}: scoring-features.json tem "rows" presente mas não é array (typeof ${typeof rawRows}) — tratando como 0 linhas. Possível schema drift.`);
  }
  const rows: ScoringFeatureRow[] = Array.isArray(rawRows) ? rawRows : [];
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

  try {
    writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  } catch (err) {
    // Fase de ESCRITA — disco cheio, permissão, OneDrive travado. Status
    // distinto de "error" (fase de leitura) de propósito, mesmo padrão de
    // backfill-scoring-features.ts.
    return { edition, status: "error-write", error: err instanceof Error ? err.message : String(err) };
  }
  return { edition, status: "written", rows: shadowRows.length, overwritten_previous_hash: overwrittenHash };
}

export function runComputeShadowScores(
  editionsRoot: string,
  opts: { edition?: string; weightsHash: string; force: boolean },
): ShadowResult[] {
  const file = loadCandidateWeights(opts.weightsHash);
  const editionDirs = enumerateEditionDirs(editionsRoot);

  if (opts.edition && !editionDirs.has(opts.edition)) {
    // Achado de review do #7977: um `--edition` com AAMMDD inexistente
    // (typo, diretório ainda não materializado, --editions-dir errado)
    // produzia `targets = []` silenciosamente — 0 edições processadas,
    // exit 0, indistinguível de sucesso genuíno. Agora reportado como
    // "error" nomeado, nunca um resultado vazio silencioso.
    return [{ edition: opts.edition, status: "error", error: `Edição "${opts.edition}" não encontrada sob ${editionsRoot} (typo no AAMMDD, --editions-dir errado, ou diretório ainda não materializado?).` }];
  }

  const targets: Array<[string, string]> = opts.edition
    ? [[opts.edition, editionDirs.get(opts.edition)!]]
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
    const overwritten = results.filter((r) => r.overwritten_previous_hash !== undefined);
    console.log(
      `[compute-shadow-scores] ${results.length} edições processadas — ${JSON.stringify(byStatus)}` +
        (overwritten.length > 0 ? ` (${overwritten.length} sobrescreveram um scoring-shadow.json pré-existente via --force)` : ""),
    );
    for (const r of overwritten) console.log(`  --force sobrescreveu ${r.edition}: candidato anterior era ${r.overwritten_previous_hash ?? "ilegível"}, agora ${weightsHashArg}`);
    for (const r of results) {
      if (r.status === "error" || r.status === "error-write") console.error(`  ERRO (${r.status}) ${r.edition}: ${r.error}`);
    }
    process.exit(results.some((r) => r.status === "error" || r.status === "error-write") ? 1 : 0);
  } catch (err) {
    console.error("[compute-shadow-scores] falha:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
