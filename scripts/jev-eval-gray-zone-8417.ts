/**
 * jev-eval-gray-zone-8417.ts (#8417 — medição 4 do epic #8412)
 *
 * Avaliação dedicada pras duas features de par (`dedup-grayzone-8417`,
 * `highlight-themes-grayzone-8417`) — mesma razão de existir de
 * `jev-eval-negative-impact.ts` (#8414): `jev-eval.ts` genérico só compara
 * respostas `choice`, e estas duas medições usam `noul` sobre um PAR de
 * itens (`state = {a, b}`), não um item único.
 *
 * Booleaniza a resposta `noul` (`probability >= threshold`) contra o
 * vocabulário mesma_historia/historias_distintas (dedup) ou
 * mesmo_tema/temas_distintos (highlight-themes), e roda o mesmo par
 * mecanismo×Jev×McNemar que as outras avaliações do epic rodam.
 *
 * Uso:
 *   npx tsx scripts/jev-eval-gray-zone-8417.ts --feature dedup-grayzone-8417 [--threshold-pct 50] [--runs 3]
 *   npx tsx scripts/jev-eval-gray-zone-8417.ts --feature highlight-themes-grayzone-8417
 *
 * `--runs N` repete a chamada à API N vezes (cache DESLIGADO entre runs) —
 * `docs/jev.md` documenta que a API `noul` não é determinística (achado do
 * #8413/#8414) — decidir "adotar" olhando 1 rodada só não é confiável.
 */

import { resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getIntArg, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { loadLabeledSample, type LabeledItem } from "./lib/blind-label-core.ts";
import { getFeature } from "./lib/blind-label-features.ts";
import { getJevQuestionSpec } from "./lib/jev-questions.ts";
import { askJevBatch, type JevNoulAnswer } from "./lib/jev.ts";
import { mcnemarTest } from "./lib/mcnemar.ts";
import { buildConfusionMatrix, renderConfusionMatrix, confidenceAccuracyCurve } from "./jev-eval.ts";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Rótulo "positivo" (probabilidade `noul` alta) por feature — o outro
 * rótulo do vocabulário `FeatureDef.labels` é o negativo. Só o NOME do
 * rótulo positivo precisa ser declarado aqui (não dá pra derivar
 * automaticamente do vocabulário de 2 elementos qual é "positivo" — é
 * semântica da pergunta, não da estrutura); `resolveLabels` abaixo valida
 * contra `def.labels` (fonte única em `blind-label-features.ts`) e lança
 * cedo — com o feature id no erro — se o nome citado aqui não existir mais
 * lá (ex: renomeado num refactor futuro), em vez de falhar tarde/confuso
 * num mismatch de string na hora do eval.
 */
const POSITIVE_LABEL_BY_FEATURE: Record<string, string> = {
  "dedup-grayzone-8417": "mesma_historia",
  "highlight-themes-grayzone-8417": "mesmo_tema",
};

function resolveLabels(feature: string, labels: readonly string[]): { positive: string; negative: string } {
  const positive = POSITIVE_LABEL_BY_FEATURE[feature];
  if (!positive) throw new Error(`POSITIVE_LABEL_BY_FEATURE: feature desconhecida ${feature}`);
  if (!labels.includes(positive)) {
    throw new Error(`POSITIVE_LABEL_BY_FEATURE[${feature}]="${positive}" não está em FeatureDef.labels=[${labels.join(", ")}] — vocabulário divergiu, atualize os dois juntos`);
  }
  const negative = labels.find((l) => l !== positive);
  if (!negative) throw new Error(`feature ${feature}: labels=[${labels.join(", ")}] não tem um 2º rótulo pra ser o negativo`);
  return { positive, negative };
}

export interface GrayZoneEvalItem {
  id: string;
  label: string;
  mechanismGuess: string;
  mechanismCorrect: boolean;
  jevProbability: number | null;
  jevConfidence: number | null;
  jevGuess: string | null;
  jevCorrect: boolean | null;
}

export async function evaluateOnce(opts: {
  feature: string;
  apiKey: string;
  threshold: number;
  cacheDir?: string | null;
  fetchImpl?: typeof fetch;
  rootDir?: string;
}): Promise<{ results: GrayZoneEvalItem[]; errors: Map<string, unknown> }> {
  const rootDir = opts.rootDir ?? ROOT;
  const def = getFeature(opts.feature);
  if (!def) throw new Error(`feature desconhecida: ${opts.feature}`);
  const spec = getJevQuestionSpec(opts.feature);
  if (!spec) throw new Error(`sem pergunta Jev registrada pra ${opts.feature}`);

  const labeled = loadLabeledSample(rootDir, opts.feature);
  if (!labeled) throw new Error(`sem amostra gerada — rode blind-label-sample.ts --generate primeiro`);

  const optOut = new Set(def.optOutLabels ?? []);
  const usable = labeled.filter((i): i is LabeledItem & { label: string } => !!i.label && !optOut.has(i.label));

  const { positive: posLabel, negative: negLabel } = resolveLabels(opts.feature, def.labels);

  const { results: jevResults, errors } = await askJevBatch(
    usable.map((item) => ({ id: item.id, state: item.jevState, questions: [spec.question], cacheKey: item.id })),
    { apiKey: opts.apiKey, cacheDir: opts.cacheDir, fetchImpl: opts.fetchImpl },
  );
  const jevById = new Map(jevResults.map((r) => [r.id, r.answers[0] as JevNoulAnswer | undefined]));

  const results: GrayZoneEvalItem[] = usable.map((item) => {
    const a = jevById.get(item.id);
    const jevProbability = a && a.type === "noul" ? a.probability : null;
    const jevGuess = jevProbability === null ? null : jevProbability >= opts.threshold ? posLabel : negLabel;
    return {
      id: item.id,
      label: item.label,
      mechanismGuess: item.hiddenGuess,
      mechanismCorrect: item.hiddenGuess === item.label,
      jevProbability,
      jevConfidence: a?.confidence ?? null,
      jevGuess,
      jevCorrect: jevGuess === null ? null : jevGuess === item.label,
    };
  });

  return { results, errors };
}

export function renderReport(feature: string, results: GrayZoneEvalItem[], errorCount: number, threshold: number, runLabel?: string): string {
  const n = results.length;
  const withJev = results.filter((r) => r.jevGuess !== null);
  const mechAgree = results.filter((r) => r.mechanismCorrect).length;
  const jevAgree = withJev.filter((r) => r.jevCorrect).length;

  const lines: string[] = [];
  lines.push(`# Jev eval — \`${feature}\`${runLabel ? ` (${runLabel})` : ""}`);
  lines.push("");
  lines.push(`n=${n} rotulado(s), limiar Jev=${threshold}${errorCount > 0 ? `, ${errorCount} falha(s) de transporte excluída(s)` : ""}`);
  lines.push("");
  lines.push(`| mecanismo | acurácia |`);
  lines.push(`|---|---|`);
  lines.push(`| Jaccard/thresholdForPair (atual) | ${mechAgree}/${n} (${((mechAgree / n) * 100).toFixed(1)}%) |`);
  lines.push(`| Jev (noul ≥ ${threshold}) | ${jevAgree}/${withJev.length} (${withJev.length > 0 ? ((jevAgree / withJev.length) * 100).toFixed(1) : "—"}%) |`);
  lines.push("");

  lines.push(renderConfusionMatrix(buildConfusionMatrix(results.map((r) => ({ label: r.label, guess: r.mechanismGuess }))), "Matriz de confusão — mecanismo atual"));
  lines.push("");
  lines.push(renderConfusionMatrix(buildConfusionMatrix(withJev.map((r) => ({ label: r.label, guess: r.jevGuess! }))), "Matriz de confusão — Jev"));
  lines.push("");

  const both = withJev;
  const aCorrectBWrong = both.filter((r) => r.mechanismCorrect && !r.jevCorrect).length;
  const aWrongBCorrect = both.filter((r) => !r.mechanismCorrect && r.jevCorrect).length;
  const mc = mcnemarTest({ aCorrectBWrong, aWrongBCorrect });
  lines.push(`**McNemar (mecanismo atual vs. Jev)** — n comparável=${both.length}`);
  lines.push("");
  lines.push(`- mecanismo certo / Jev errado: ${mc.b}`);
  lines.push(`- mecanismo errado / Jev certo: ${mc.c}`);
  lines.push(`- χ² (Yates) = ${Number.isNaN(mc.chiSquare) ? "n/a (sem discordância)" : mc.chiSquare.toFixed(3)}`);
  lines.push(`- p (χ²) = ${mc.pValueChiSquare.toFixed(4)}`);
  lines.push(`- p (exato, binomial) = ${mc.pValueExact.toFixed(4)}`);
  lines.push("");

  const withConfidence = withJev.filter((r) => r.jevConfidence !== null).map((r) => ({ confidence: r.jevConfidence as number, correct: !!r.jevCorrect }));
  const curve = confidenceAccuracyCurve(withConfidence);
  lines.push(`**Curva confiança × acerto (Jev)**`);
  lines.push("");
  lines.push(`| faixa de confiança | n | acerto |`);
  lines.push(`|---|---|---|`);
  for (const b of curve) lines.push(`| ${b.range} | ${b.n} | ${Number.isNaN(b.accuracy) ? "—" : `${(b.accuracy * 100).toFixed(1)}%`} |`);
  lines.push("");

  lines.push(`**Discordâncias (mecanismo → Jev, ambos vs. rótulo)**`);
  lines.push("");
  for (const r of both) {
    if (r.mechanismGuess !== r.jevGuess) {
      lines.push(`- \`${r.label}\` — mecanismo=${r.mechanismGuess}, Jev=${r.jevGuess} (p=${r.jevProbability?.toFixed(2)}, conf=${r.jevConfidence?.toFixed(2)}) — ${r.id.slice(0, 120)}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const feature = getStringArg(argv, "feature");
  if (!feature) {
    console.error("uso: npx tsx scripts/jev-eval-gray-zone-8417.ts --feature dedup-grayzone-8417|highlight-themes-grayzone-8417 [--threshold-pct 50] [--runs 3]");
    process.exit(2);
  }
  loadProjectEnv(ROOT);
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    console.error("TYPESAFE_API_KEY ausente — sem key não há como consultar Jev pra comparação.");
    process.exit(2);
  }
  const threshold = (getIntArg(argv, "threshold-pct", { min: 0, max: 100 }) ?? 50) / 100;
  const runs = getIntArg(argv, "runs", { min: 1 }) ?? 1;
  const cacheDirArg = getStringArg(argv, "cache-dir");

  for (let run = 1; run <= runs; run++) {
    const cacheDir = runs > 1 ? null : (cacheDirArg ?? resolve(ROOT, "data", "jev-eval", feature, "cache"));
    try {
      const { results, errors } = await evaluateOnce({ feature, apiKey, threshold, cacheDir });
      console.log(renderReport(feature, results, errors.size, threshold, runs > 1 ? `run ${run}/${runs}` : undefined));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
