#!/usr/bin/env tsx
/**
 * scripts/calibration-power-report.ts (#7976, Camada 2 da #7972)
 *
 * Relatório read-only: pra cada feature booleana calibrável de
 * `scripts/lib/scoring-features.ts`, mede se ela já tem EVIDÊNCIA
 * suficiente no corpus histórico pra justificar uma calibração — sem
 * calibrar nada, sem escrever em nenhum arquivo de produção.
 *
 * Pergunta respondida: "artigos com a feature X sobrevivem no
 * `01-approved.json` (ficam no pool ou viram destaque) numa taxa
 * diferente de artigos sem X, dentro da MESMA edição — e essa diferença
 * é maior do que ruído explicaria?"
 *
 * Método (#7972 §"Camada 2", barra de evidência):
 * 1. Por edição, `kept` = URL presente em QUALQUER bucket de
 *    `01-approved.json` (incluindo `highlights`) — o candidato sobreviveu
 *    à aprovação do editor, seja no pool ou promovido.
 * 2. Por feature booleana, compara a taxa de `kept` entre presente/ausente,
 *    agregando todas as edições (não par-a-par dentro da MESMA edição —
 *    simplificação da v1; ver nota de escopo abaixo).
 * 3. Barra de evidência: ≥30 linhas com a feature presente E ≥30 ausente,
 *    E ≥40 edições-calendário "avaliáveis" (a edição tem pelo menos 1 linha
 *    com e 1 sem a feature).
 * 4. Baseline nulo: embaralha o rótulo `kept` DENTRO de cada edição
 *    (preserva quantos itens aquela edição manteve, só reatribui QUAIS),
 *    recalcula a diferença de taxa sob esse null, repete N vezes — o
 *    p-valor empírico é a fração de permutações cuja |diferença| iguala ou
 *    supera a observada.
 * 5. Consistência forward-chaining: divide as edições em metade mais
 *    antiga / metade mais recente (cronológico), recalcula a diferença em
 *    cada metade — reporta se o SINAL (direção) é o mesmo nas duas.
 *
 * Nota de escopo (v1): o teste de (2) é agregado, não par-a-par restrito à
 * mesma edição (a versão completa do design da #7972 pede comparação
 * dentro da MESMA edição — Bradley-Terry). A permutação em (4) já restringe
 * o embaralhamento a DENTRO de cada edição (preserva a composição por
 * edição), o que aproxima boa parte do controle que a comparação par-a-par
 * daria, mas não é idêntico. Registrado aqui pra não fingir rigor que o
 * método ainda não tem — refinamento fica pra quando `calibrate-scoring-
 * weights.ts` (regressão de verdade) for escrito.
 *
 * Features numéricas (`score`, `score_base`, `recency_hours`,
 * `title_char_count`, `cluster_sources_count`, entre outras — todo campo
 * de `ScoringFeatureRow` que não é booleano) NÃO são cobertas por este
 * relatório v1 — só as booleanas calibráveis. Ver `CANDIDATE_FEATURES`
 * abaixo pra lista exaustiva do que ESTÁ coberto.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { NON_CALIBRATABLE_FEATURES, type ScoringFeatureRow } from "./lib/scoring-features.ts";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Features booleanas candidatas a calibração — exclui explicitamente tudo em
 * NON_CALIBRATABLE_FEATURES. Exportado (junto com `CandidateFeature`) pra ser
 * a ÚNICA fonte de verdade de "quais nomes de feature um peso candidato pode
 * usar" — `scripts/lib/shadow-score.ts` importa `CandidateFeature` pra tipar
 * `CandidateWeights`, em vez de aceitar qualquer `string` como chave (achado
 * de review do #7977: chave com typo/nome obsoleto degradava
 * silenciosamente pra peso 0, sem nenhum sinal).
 */
export const CANDIDATE_FEATURES = (
  ["primary_source", "hands_on", "academy", "howto_br", "howto_br_source", "has_official_link", "negative_impact"] as const
).filter((f) => !NON_CALIBRATABLE_FEATURES.has(f));

export type CandidateFeature = (typeof CANDIDATE_FEATURES)[number];

const EVENT_COUNT_MIN = 30;
const EVALUABLE_EDITIONS_MIN = 40;
const PERMUTATIONS = 500;

interface EditionRows {
  edition: string;
  rows: ScoringFeatureRow[];
  kept: boolean[]; // paralelo a rows — kept[i] corresponde a rows[i]
}

/** Lê todas as URLs presentes em QUALQUER bucket de `01-approved.json` (inclui highlights via article.url/.url). */
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

function loadEditionRows(editionsRoot: string): { editions: EditionRows[]; skipped: Array<{ edition: string; reason: string }> } {
  const editionDirs = enumerateEditionDirs(editionsRoot);
  const out: EditionRows[] = [];
  const skipped: Array<{ edition: string; reason: string }> = [];
  for (const [edition, dir] of [...editionDirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const featuresPath = join(dir, "_internal", "scoring-features.json");
    const approvedPath = join(dir, "_internal", "01-approved.json");
    if (!existsSync(featuresPath) || !existsSync(approvedPath)) continue; // candidata nem existe — não é "pulada", nunca foi elegível
    try {
      const featuresPayload = JSON.parse(readFileSync(featuresPath, "utf8"));
      const approvedJson = JSON.parse(readFileSync(approvedPath, "utf8"));
      const rows: ScoringFeatureRow[] = Array.isArray(featuresPayload?.rows) ? featuresPayload.rows : [];
      if (rows.length === 0) {
        skipped.push({ edition, reason: "scoring-features.json sem rows (ausente, não-array, ou vazio)" });
        continue;
      }
      const keptUrls = keptUrlsFromApproved(approvedJson);
      const kept = rows.map((r) => keptUrls.has(r.url));
      out.push({ edition, rows, kept });
    } catch (err) {
      // Achado de review do #7976: catch sem discriminação escondia erro de
      // I/O real (permissão, OneDrive travado, corrida ENOENT) sob o mesmo
      // rótulo de "JSON malformado desta edição" — e nenhum dos dois casos
      // aparecia em lugar nenhum do relatório. Agora sempre registrado em
      // `skipped`, nunca só um `continue` silencioso.
      const reason = err instanceof SyntaxError ? `JSON malformado: ${err.message}` : `erro de leitura/I-O: ${err instanceof Error ? err.message : String(err)}`;
      skipped.push({ edition, reason });
      continue;
    }
  }
  return { editions: out, skipped };
}

/** Pseudo-random determinístico (mulberry32) — permite reproduzir o relatório exato com a mesma seed, sem depender de Math.random() global. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates in-place, usando o gerador determinístico fornecido. */
function shuffleInPlace<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

interface FeatureReport {
  feature: CandidateFeature;
  n_true: number;
  n_false: number;
  kept_rate_true: number;
  kept_rate_false: number;
  diff: number;
  evaluable_editions: number;
  passes_event_bar: boolean;
  null_p_value: number;
  forward_chaining_consistent: boolean;
  early_half_diff: number;
  late_half_diff: number;
}

function featureValue(row: ScoringFeatureRow, feature: CandidateFeature): boolean {
  return (row as unknown as Record<string, unknown>)[feature] === true;
}

/**
 * Contagens brutas de kept(F=true)/kept(F=false), agregadas sobre o
 * subconjunto de edições dado. `nTrue`/`nFalse` são SEMPRE as contagens
 * reais — nunca zeram quando um dos lados está vazio (achado de review do
 * #7976: uma versão anterior fazia `nTrue`/`nFalse` colapsarem pra 0
 * JUNTOS sempre que um dos dois lados tinha 0 linhas, então uma feature
 * praticamente constante — ex: `academy=true` em 500 linhas, `false` em
 * nenhuma — era relatada como "n_true=0, n_false=0", escondendo as 500
 * linhas reais). `diff` é `null` só quando genuinamente indefinido (um dos
 * dois lados tem 0 linhas).
 */
function computeCounts(
  editions: EditionRows[],
  feature: CandidateFeature,
): { nTrue: number; nFalse: number; keptTrue: number; keptFalse: number; diff: number | null } {
  let trueTotal = 0;
  let trueKept = 0;
  let falseTotal = 0;
  let falseKept = 0;
  for (const ed of editions) {
    for (let i = 0; i < ed.rows.length; i++) {
      if (featureValue(ed.rows[i], feature)) {
        trueTotal++;
        if (ed.kept[i]) trueKept++;
      } else {
        falseTotal++;
        if (ed.kept[i]) falseKept++;
      }
    }
  }
  const diff = trueTotal > 0 && falseTotal > 0 ? trueKept / trueTotal - falseKept / falseTotal : null;
  return { nTrue: trueTotal, nFalse: falseTotal, keptTrue: trueKept, keptFalse: falseKept, diff };
}

function analyzeFeature(editions: EditionRows[], feature: CandidateFeature, seed: number): FeatureReport {
  const observed = computeCounts(editions, feature);
  const { nTrue, nFalse, keptTrue, keptFalse } = observed;
  const diff = observed.diff ?? 0; // 0 só quando indefinido (um lado vazio) — nTrue/nFalse acima já carregam a contagem real nesse caso
  const keptRateTrue = nTrue > 0 ? keptTrue / nTrue : 0;
  const keptRateFalse = nFalse > 0 ? keptFalse / nFalse : 0;

  let evaluableEditions = 0;
  for (const ed of editions) {
    let hasTrue = false;
    let hasFalse = false;
    for (const row of ed.rows) {
      if (featureValue(row, feature)) hasTrue = true;
      else hasFalse = true;
      if (hasTrue && hasFalse) break;
    }
    if (hasTrue && hasFalse) evaluableEditions++;
  }

  const passesEventBar = nTrue >= EVENT_COUNT_MIN && nFalse >= EVENT_COUNT_MIN && evaluableEditions >= EVALUABLE_EDITIONS_MIN;

  // Baseline nulo: embaralha `kept` DENTRO de cada edição (preserva quantos
  // itens cada edição manteve, só reatribui quais), recalcula |diff|,
  // conta quantas permutações igualam/superam a observada.
  const rand = mulberry32(seed);
  let nullExceedsOrEquals = 0;
  const absObserved = Math.abs(diff);
  for (let p = 0; p < PERMUTATIONS; p++) {
    let trueTotal = 0;
    let trueKept = 0;
    let falseTotal = 0;
    let falseKept = 0;
    for (const ed of editions) {
      const shuffledKept = [...ed.kept];
      shuffleInPlace(shuffledKept, rand);
      for (let i = 0; i < ed.rows.length; i++) {
        if (featureValue(ed.rows[i], feature)) {
          trueTotal++;
          if (shuffledKept[i]) trueKept++;
        } else {
          falseTotal++;
          if (shuffledKept[i]) falseKept++;
        }
      }
    }
    const nullDiff = trueTotal > 0 && falseTotal > 0 ? trueKept / trueTotal - falseKept / falseTotal : 0;
    if (Math.abs(nullDiff) >= absObserved) nullExceedsOrEquals++;
  }
  const nullPValue = nullExceedsOrEquals / PERMUTATIONS;

  // Forward-chaining leve: metade cronológica antiga vs recente, mesmo sinal?
  const mid = Math.floor(editions.length / 2);
  const early = editions.slice(0, mid);
  const late = editions.slice(mid);
  const earlyDiff = computeCounts(early, feature).diff ?? 0;
  const lateDiff = computeCounts(late, feature).diff ?? 0;
  const forwardChainingConsistent = early.length > 0 && late.length > 0 && Math.sign(earlyDiff) === Math.sign(lateDiff) && earlyDiff !== 0;

  return {
    feature,
    n_true: nTrue,
    n_false: nFalse,
    kept_rate_true: keptRateTrue,
    kept_rate_false: keptRateFalse,
    diff,
    evaluable_editions: evaluableEditions,
    passes_event_bar: passesEventBar,
    null_p_value: nullPValue,
    forward_chaining_consistent: forwardChainingConsistent,
    early_half_diff: earlyDiff,
    late_half_diff: lateDiff,
  };
}

export interface PowerReportResult {
  editions_analyzed: number;
  /** Edições candidatas (têm scoring-features.json + 01-approved.json) que foram puladas mesmo assim — dado malformado (JSON inválido) ou `rows` ausente/vazio. Nunca escondido: um relatório de evidência que perde linhas em silêncio é pior que um que não perde nenhuma (achado de review do #7976). */
  editions_skipped: Array<{ edition: string; reason: string }>;
  features: FeatureReport[];
}

export function buildPowerReport(editionsRoot: string, seed = 42): PowerReportResult {
  const { editions, skipped } = loadEditionRows(editionsRoot);
  const features = CANDIDATE_FEATURES.map((f, i) => analyzeFeature(editions, f, seed + i));
  return { editions_analyzed: editions.length, editions_skipped: skipped, features };
}

function formatReport(report: PowerReportResult): string {
  const lines: string[] = [];
  lines.push(`[calibration-power-report] ${report.editions_analyzed} edições analisadas (scoring-features.json + 01-approved.json presentes).`);
  if (report.editions_skipped.length > 0) {
    lines.push(
      `  ${report.editions_skipped.length} edição(ões) candidata(s) PULADA(S) (arquivo presente mas dado malformado/vazio/erro de leitura — nunca silencioso):`,
    );
    for (const s of report.editions_skipped) lines.push(`    ${s.edition}: ${s.reason}`);
  }
  lines.push("");
  for (const f of report.features) {
    const bar = f.passes_event_bar ? "PASSA a barra de evidência" : "abaixo da barra de evidência";
    lines.push(`${f.feature}: ${bar}`);
    lines.push(
      `  n_true=${f.n_true} (kept ${(f.kept_rate_true * 100).toFixed(1)}%)  n_false=${f.n_false} (kept ${(f.kept_rate_false * 100).toFixed(1)}%)  diff=${(f.diff * 100).toFixed(1)}pp  edições_avaliáveis=${f.evaluable_editions}`,
    );
    lines.push(
      `  baseline nulo: p=${f.null_p_value.toFixed(3)} (fração de ${PERMUTATIONS} permutações com |diff| >= observado)  forward-chaining consistente=${f.forward_chaining_consistent} (metade antiga=${(f.early_half_diff * 100).toFixed(1)}pp, metade recente=${(f.late_half_diff * 100).toFixed(1)}pp)`,
    );
    lines.push("");
  }
  return lines.join("\n");
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const editionsRoot = resolve(ROOT, values["editions-dir"] ?? "data/editions");
  const json = process.argv.includes("--json");
  const report = buildPowerReport(editionsRoot);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
}
