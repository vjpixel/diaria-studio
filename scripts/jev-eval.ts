/**
 * jev-eval.ts (#8413 — Fase 0 do epic #8412)
 *
 * Roda Jev (`scripts/lib/jev.ts`) e o mecanismo atual (o `hiddenGuess`
 * gravado por `scripts/lib/blind-label-features.ts` no momento em que o
 * pool foi coletado — é o palpite do mecanismo de produção, congelado no
 * disco) sobre a amostra rotulada de `--feature X`, e imprime:
 *
 *   - acurácia de cada um contra o rótulo do editor
 *   - matriz de confusão de cada um
 *   - teste de McNemar nas discordâncias entre os dois
 *   - curva confiança × acerto do Jev (pra calibrar limiar de "não agir")
 *
 * Saída em markdown, pronta pra colar na issue da medição (mesmo formato do
 * relatório do #8211).
 *
 * Itens rotulados `nao_pertence` (opt-out — "isto não deveria estar em
 * nenhum dos buckets rastreados") saem da avaliação: nem o mecanismo atual
 * nem Jev têm essa opção no vocabulário de resposta, então contar erro ali
 * puniria os dois pela mesma razão estrutural — mesmo tratamento do
 * `--report` original do #8206/#5995.
 *
 * Uso:
 *   npx tsx scripts/jev-eval.ts --feature bucket-tiebreaker-8211
 *   npx tsx scripts/jev-eval.ts --feature X --cache-dir data/jev-eval/X/cache
 *
 * `TYPESAFE_API_KEY` vem do `.env`/Doppler via `loadProjectEnv` (mesmo
 * padrão do resto do repo) — nenhum teste desta unidade chama a rede real.
 */

import { resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { loadLabeledSample, type LabeledItem } from "./lib/blind-label-core.ts";
import { getFeature } from "./lib/blind-label-features.ts";
import { getJevQuestionSpec } from "./lib/jev-questions.ts";
import { askJevBatch, type JevAnswer, type JevChoiceAnswer } from "./lib/jev.ts";
import { mcnemarTest } from "./lib/mcnemar.ts";

const ROOT = resolve(import.meta.dirname, "..");

export interface EvalItemResult {
  id: string;
  label: string;
  mechanismGuess: string;
  jevAnswer: JevAnswer | null;
  jevGuess: string | null;
  jevConfidence: number | null;
  mechanismCorrect: boolean;
  jevCorrect: boolean | null;
}

/** Extrai o "veredito comparável ao rótulo" de uma resposta Jev — só `choice` tem isso hoje (as demais medições usam `score`/`noul` com sua própria lógica de comparação, fora de escopo desta issue). */
function jevGuessFrom(answer: JevAnswer): { guess: string; confidence: number } | null {
  if (answer.type === "choice") {
    const a = answer as JevChoiceAnswer;
    return { guess: a.choice, confidence: a.confidence };
  }
  return null;
}

export function buildConfusionMatrix(
  items: Array<{ label: string; guess: string }>,
): Map<string, Map<string, number>> {
  const matrix = new Map<string, Map<string, number>>();
  for (const { label, guess } of items) {
    if (!matrix.has(label)) matrix.set(label, new Map());
    const row = matrix.get(label)!;
    row.set(guess, (row.get(guess) ?? 0) + 1);
  }
  return matrix;
}

export function renderConfusionMatrix(matrix: Map<string, Map<string, number>>, title: string): string {
  const labels = [...new Set([...matrix.keys(), ...[...matrix.values()].flatMap((r) => [...r.keys()])])].sort();
  const lines: string[] = [`**${title}**`, "", `| rótulo \\ palpite | ${labels.join(" | ")} |`, `|---|${labels.map(() => "---").join("|")}|`];
  for (const label of labels) {
    const row = matrix.get(label) ?? new Map();
    lines.push(`| ${label} | ${labels.map((g) => row.get(g) ?? 0).join(" | ")} |`);
  }
  return lines.join("\n");
}

export interface ConfidenceBucket {
  range: string;
  n: number;
  correct: number;
  accuracy: number;
}

/** Curva confiança × acerto — 5 baldes de 0.2 em confiança, [0,1]. */
export function confidenceAccuracyCurve(
  items: Array<{ confidence: number; correct: boolean }>,
): ConfidenceBucket[] {
  const buckets: ConfidenceBucket[] = [];
  for (let i = 0; i < 5; i++) {
    const lo = i * 0.2;
    const hi = i === 4 ? 1.0001 : (i + 1) * 0.2;
    const inBucket = items.filter((it) => it.confidence >= lo && it.confidence < hi);
    const correct = inBucket.filter((it) => it.correct).length;
    buckets.push({
      range: `[${lo.toFixed(1)}, ${i === 4 ? "1.0" : hi.toFixed(1)})`,
      n: inBucket.length,
      correct,
      accuracy: inBucket.length > 0 ? correct / inBucket.length : NaN,
    });
  }
  return buckets;
}

export async function evaluateFeature(
  feature: string,
  opts: { apiKey: string; cacheDir?: string | null; fetchImpl?: typeof fetch; rootDir?: string },
): Promise<{ results: EvalItemResult[]; errors: Map<string, unknown> }> {
  const rootDir = opts.rootDir ?? ROOT;
  const def = getFeature(feature);
  if (!def) throw new Error(`feature desconhecida: ${feature}`);
  const spec = getJevQuestionSpec(feature);
  if (!spec) throw new Error(`sem pergunta Jev registrada pra feature: ${feature} (ver scripts/lib/jev-questions.ts)`);

  const labeled = loadLabeledSample(rootDir, feature);
  if (!labeled) throw new Error(`sem amostra gerada pra ${feature} — rode blind-label-sample.ts --generate primeiro`);

  const usable = labeled.filter((i): i is LabeledItem & { label: string } => !!i.label && i.label !== "nao_pertence");
  if (usable.length === 0) {
    return { results: [], errors: new Map() };
  }

  const { results: jevResults, errors } = await askJevBatch(
    usable.map((item) => ({ id: item.id, state: item.jevState, questions: [spec.question], cacheKey: item.id })),
    { apiKey: opts.apiKey, cacheDir: opts.cacheDir, fetchImpl: opts.fetchImpl },
  );
  const jevById = new Map(jevResults.map((r) => [r.id, r.answers[0] ?? null]));

  const results: EvalItemResult[] = usable.map((item) => {
    const jevAnswer = jevById.get(item.id) ?? null;
    const jevParsed = jevAnswer ? jevGuessFrom(jevAnswer) : null;
    return {
      id: item.id,
      label: item.label,
      mechanismGuess: item.hiddenGuess,
      jevAnswer,
      jevGuess: jevParsed?.guess ?? null,
      jevConfidence: jevParsed?.confidence ?? null,
      mechanismCorrect: item.hiddenGuess === item.label,
      jevCorrect: jevParsed ? jevParsed.guess === item.label : null,
    };
  });

  return { results, errors };
}

export function renderMarkdownReport(feature: string, results: EvalItemResult[], errorCount: number): string {
  const n = results.length;
  const withJev = results.filter((r) => r.jevGuess !== null);
  const mechanismAgree = results.filter((r) => r.mechanismCorrect).length;
  const jevAgree = withJev.filter((r) => r.jevCorrect).length;

  const lines: string[] = [];
  lines.push(`# Jev eval — feature \`${feature}\``);
  lines.push("");
  lines.push(`n=${n} rotulado(s)${errorCount > 0 ? ` (${errorCount} falha(s) de transporte, excluído(s))` : ""}`);
  lines.push("");
  lines.push(`| mecanismo | acurácia |`);
  lines.push(`|---|---|`);
  lines.push(`| atual | ${mechanismAgree}/${n} (${((mechanismAgree / n) * 100).toFixed(1)}%) |`);
  lines.push(`| Jev | ${jevAgree}/${withJev.length} (${withJev.length > 0 ? ((jevAgree / withJev.length) * 100).toFixed(1) : "—"}%) |`);
  lines.push("");

  lines.push(
    renderConfusionMatrix(
      buildConfusionMatrix(results.map((r) => ({ label: r.label, guess: r.mechanismGuess }))),
      "Matriz de confusão — mecanismo atual",
    ),
  );
  lines.push("");
  lines.push(
    renderConfusionMatrix(
      buildConfusionMatrix(withJev.map((r) => ({ label: r.label, guess: r.jevGuess! }))),
      "Matriz de confusão — Jev",
    ),
  );
  lines.push("");

  // McNemar: discorda entre os dois classificadores, em relação ao rótulo.
  const both = withJev; // só itens com resposta de ambos os lados
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

  // Curva confiança × acerto do Jev.
  const withConfidence = withJev
    .filter((r) => r.jevConfidence !== null)
    .map((r) => ({ confidence: r.jevConfidence as number, correct: !!r.jevCorrect }));
  const curve = confidenceAccuracyCurve(withConfidence);
  lines.push(`**Curva confiança × acerto (Jev)**`);
  lines.push("");
  lines.push(`| faixa de confiança | n | acerto |`);
  lines.push(`|---|---|---|`);
  for (const b of curve) {
    lines.push(`| ${b.range} | ${b.n} | ${Number.isNaN(b.accuracy) ? "—" : `${(b.accuracy * 100).toFixed(1)}%`} |`);
  }
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const feature = getStringArg(argv, "feature");
  if (!feature) {
    console.error("uso: npx tsx scripts/jev-eval.ts --feature X [--cache-dir path]");
    process.exit(2);
  }
  loadProjectEnv(ROOT);
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    console.error("TYPESAFE_API_KEY ausente — sem key não há como consultar Jev pra comparação.");
    process.exit(2);
  }
  const cacheDirArg = getStringArg(argv, "cache-dir");
  const cacheDir = cacheDirArg ?? resolve(ROOT, "data", "jev-eval", feature, "cache");

  try {
    const { results, errors } = await evaluateFeature(feature, { apiKey, cacheDir });
    console.log(renderMarkdownReport(feature, results, errors.size));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
