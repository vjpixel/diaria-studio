/**
 * jev-eval-negative-impact.ts (#8414 — medição 1 do epic #8412)
 *
 * Avaliação dedicada pra feature `negative-impact-8414` — `jev-eval.ts`
 * genérico só sabe comparar respostas `choice` (ver docstring de
 * `jevGuessFrom` naquele arquivo: "as demais medições usam score/noul com
 * sua própria lógica de comparação, fora de escopo desta issue" — #8413
 * deferiu essa lógica pra cada medição que primeiro usar `noul`/`score`,
 * que é exatamente o caso desta issue).
 *
 * Booleaniza a resposta `noul` (`probability >= threshold`) contra o
 * vocabulário `dano_real`/`nao_dano` do gabarito, e roda o mesmo par
 * mecanismo×Jev×McNemar que `jev-eval.ts` roda pra `choice`.
 *
 * Uso:
 *   npx tsx scripts/jev-eval-negative-impact.ts [--threshold 0.5] [--runs 3]
 *
 * `--runs N` repete a chamada à API N vezes (cache DESLIGADO entre runs) —
 * necessário porque `docs/jev.md` documenta que a API não é determinística
 * (achado #8413: 3 chamadas idênticas deram 19/22, 17/22, 18/22 no gabarito
 * do #8211) — decidir "adotar" olhando 1 rodada só não é confiável.
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
const FEATURE = "negative-impact-8414";

export interface NegImpactEvalItem {
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
  apiKey: string;
  threshold: number;
  cacheDir?: string | null;
  fetchImpl?: typeof fetch;
  rootDir?: string;
}): Promise<{ results: NegImpactEvalItem[]; errors: Map<string, unknown> }> {
  const rootDir = opts.rootDir ?? ROOT;
  const def = getFeature(FEATURE);
  if (!def) throw new Error(`feature desconhecida: ${FEATURE}`);
  const spec = getJevQuestionSpec(FEATURE);
  if (!spec) throw new Error(`sem pergunta Jev registrada pra ${FEATURE}`);

  const labeled = loadLabeledSample(rootDir, FEATURE);
  if (!labeled) throw new Error(`sem amostra gerada — rode blind-label-sample.ts --generate primeiro`);

  const optOut = new Set(def.optOutLabels ?? []);
  const usable = labeled.filter((i): i is LabeledItem & { label: string } => !!i.label && !optOut.has(i.label));

  const { results: jevResults, errors } = await askJevBatch(
    usable.map((item) => ({ id: item.id, state: item.jevState, questions: [spec.question], cacheKey: item.id })),
    { apiKey: opts.apiKey, cacheDir: opts.cacheDir, fetchImpl: opts.fetchImpl },
  );
  const jevById = new Map(jevResults.map((r) => [r.id, r.answers[0] as JevNoulAnswer | undefined]));

  const results: NegImpactEvalItem[] = usable.map((item) => {
    const a = jevById.get(item.id);
    const jevProbability = a && a.type === "noul" ? a.probability : null;
    const jevGuess = jevProbability === null ? null : jevProbability >= opts.threshold ? "dano_real" : "nao_dano";
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

export function renderReport(results: NegImpactEvalItem[], errorCount: number, threshold: number, runLabel?: string): string {
  const n = results.length;
  const withJev = results.filter((r) => r.jevGuess !== null);
  const mechAgree = results.filter((r) => r.mechanismCorrect).length;
  const jevAgree = withJev.filter((r) => r.jevCorrect).length;

  const lines: string[] = [];
  lines.push(`# Jev eval — \`negative-impact-8414\`${runLabel ? ` (${runLabel})` : ""}`);
  lines.push("");
  lines.push(`n=${n} rotulado(s), limiar Jev=${threshold}${errorCount > 0 ? `, ${errorCount} falha(s) de transporte excluída(s)` : ""}`);
  lines.push("");
  lines.push(`| mecanismo | acurácia |`);
  lines.push(`|---|---|`);
  lines.push(`| scorer-chunk (atual) | ${mechAgree}/${n} (${((mechAgree / n) * 100).toFixed(1)}%) |`);
  lines.push(`| Jev (noul ≥ ${threshold}) | ${jevAgree}/${withJev.length} (${withJev.length > 0 ? ((jevAgree / withJev.length) * 100).toFixed(1) : "—"}%) |`);
  lines.push("");

  lines.push(renderConfusionMatrix(buildConfusionMatrix(results.map((r) => ({ label: r.label, guess: r.mechanismGuess }))), "Matriz de confusão — scorer-chunk"));
  lines.push("");
  lines.push(renderConfusionMatrix(buildConfusionMatrix(withJev.map((r) => ({ label: r.label, guess: r.jevGuess! }))), "Matriz de confusão — Jev"));
  lines.push("");

  const both = withJev;
  const aCorrectBWrong = both.filter((r) => r.mechanismCorrect && !r.jevCorrect).length;
  const aWrongBCorrect = both.filter((r) => !r.mechanismCorrect && r.jevCorrect).length;
  const mc = mcnemarTest({ aCorrectBWrong, aWrongBCorrect });
  lines.push(`**McNemar (scorer-chunk vs. Jev)** — n comparável=${both.length}`);
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
      lines.push(`- \`${r.label}\` — mecanismo=${r.mechanismGuess}, Jev=${r.jevGuess} (p=${r.jevProbability?.toFixed(2)}, conf=${r.jevConfidence?.toFixed(2)}) — ${r.id.slice(0, 90)}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
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
    // Cache OFF entre runs quando runs>1 — o objetivo é medir a variância real
    // da API (#8413 achado: não é determinística), não servir do cache.
    const cacheDir = runs > 1 ? null : (cacheDirArg ?? resolve(ROOT, "data", "jev-eval", FEATURE, "cache"));
    try {
      const { results, errors } = await evaluateOnce({ apiKey, threshold, cacheDir });
      console.log(renderReport(results, errors.size, threshold, runs > 1 ? `run ${run}/${runs}` : undefined));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
