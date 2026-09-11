#!/usr/bin/env tsx
/**
 * scripts/calibrate-scoring-weights.ts (#7990, Camada 2 da #7972 — regressão
 * de verdade, deferida da Fase 2/#7976)
 *
 * Regressão logística L2 (`scripts/lib/logistic-regression.ts`) que aprende
 * um coeficiente por feature booleana candidata que JÁ PASSA a barra de
 * evidência de `calibration-power-report.ts` — nunca ajusta sobre feature
 * sem evidência suficiente. Reusa `analyze-destaque-overrides.ts`/
 * `calibration-power-report.ts` pros dados rotulados, `shadow-score.ts` pro
 * cálculo do score alternativo de validação, `source-concentration.ts`
 * (HHI) e `validate-domain-diversity.ts` (`DEFAULT_MAX_PER_DOMAIN`) pros
 * guardrails de concentração de fonte — nenhuma dessas lógicas duplicada.
 *
 * Read-only: NUNCA escreve em `.claude/agents/scorer*.md`, `context/scoring/
 * rubric.json`, nem em nenhum arquivo de produção. A única escrita (com
 * `--write`) é um NOVO arquivo em `context/scoring/candidate-weights/` — a
 * mesma superfície aditiva que `compute-shadow-scores.ts` já usa (#7977).
 * Abrir PR de verdade com o resultado (draft, label `needs-editor-signoff`)
 * é ação de FORA deste script — mesma separação que todo o resto da camada
 * de calibração já segue: script decide/mede, sessão que roda o script cuida
 * de git/PR (REGRA DE OURO, #7972).
 *
 * ## Guardrails obrigatórios (#7972 §4, herdados pela issue #7990)
 *
 * 1. **Holdout nunca usado em treino** — as `DEFAULT_HOLDOUT` (25, mesmo
 *    valor de `shadow-validation-report.ts`) edições cronologicamente mais
 *    recentes com `scoring-features.json` NUNCA entram no design matrix do
 *    fit; servem só pra medir AUC do candidato fora da amostra.
 * 2. **Cap de 2 URLs/domínio (#5735) não pode piorar** — simula, edição por
 *    edição, o conjunto "mantido" reordenando pelo `shadow_score_alt` do
 *    candidato (mesmo tamanho do conjunto mantido REAL daquela edição) e
 *    compara a taxa de estouro do cap (`DEFAULT_MAX_PER_DOMAIN`,
 *    `validate-domain-diversity.ts`) contra a taxa real observada. Candidato
 *    rejeitado se a taxa SIMULADA excede a taxa REAL.
 * 3. **Gate de concentração de fonte (HHI)** — `computeDomainConcentration`
 *    sobre os domínios de TODAS as linhas onde a feature é `true` (o
 *    "suporte" do candidato); rejeitado se HHI > `HHI_REJECTION_THRESHOLD`
 *    (2500 — o mesmo limiar convencional de "altamente concentrado" citado
 *    na docstring de `source-concentration.ts`).
 *
 * ## De log-odds pra pontos do rubrico
 *
 * O coeficiente ajustado está em unidade de log-odds, não na mesma escala
 * de pontos do rubrico real (+5 a +10). Conversão: pra cada feature elegível
 * que TAMBÉM já tem um valor de pontos existente em `context/scoring/
 * rubric.json` (ex: `primary_source` → 10), calcula a razão
 * pontos-existentes/coeficiente-ajustado; `points_per_log_odds` é a MEDIANA
 * dessas razões (robusta a sinal invertido — uma feature com efeito na
 * direção OPOSTA ao bônus atual, como `hands_on` no corpus de 11/09/2026,
 * produz razão negativa, e isso é sinal real, não erro). Se NENHUMA feature
 * elegível nesta rodada tem uma âncora em rubric.json (caso do 1º candidato
 * real, `has_official_link` — feature nova, sem bônus prévio), usa
 * `DEFAULT_POINTS_PER_LOG_ODDS` (10 — decisão de escala documentada, não
 * derivada de dado; ver trade-off log do relatório final da #7972). Este é
 * um PONTO DE PARTIDA sugerido pro editor, nunca um valor final — o PR
 * sempre mostra o coeficiente bruto E a razão de odds junto do valor em
 * pontos sugerido, pra decisão informada no sign-off.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { buildPowerReport, loadEditionRows, CANDIDATE_FEATURES, type CandidateFeature, type EditionRows } from "./calibration-power-report.ts";
import { analyzeAllEditions, type LabeledEvent } from "./analyze-destaque-overrides.ts";
import { fitL2LogisticRegression } from "./lib/logistic-regression.ts";
import { computeShadowScore, weightsHash, type CandidateWeights, type CandidateWeightsFile } from "./lib/shadow-score.ts";
import { computeDomainConcentration } from "./lib/source-concentration.ts";
import { registrableDomain } from "./lib/registrable-domain.ts";
import { DEFAULT_MAX_PER_DOMAIN } from "./validate-domain-diversity.ts";
import type { CalibrationCase } from "./lib/calibration-evidence-report.ts";

const ROOT = resolve(import.meta.dirname, "..");

export const DEFAULT_HOLDOUT = 25;
/** >2500 é convencionalmente "altamente concentrado" (escala FTC/DOJ) — mesmo limiar citado em `source-concentration.ts`. */
export const HHI_REJECTION_THRESHOLD = 2500;
/** Fallback de conversão log-odds→pontos quando nenhuma feature elegível tem âncora em rubric.json — ver docstring do módulo. */
export const DEFAULT_POINTS_PER_LOG_ODDS = 10;
/** Ver `scripts/lib/logistic-regression.ts` (`DEFAULT_L2`) pro racional medido de por que 0.01 e não 1.0. */
const L2_LAMBDA = 0.01;
const MAX_EVIDENCE_CASES = 5;

function featureValue(row: EditionRows["rows"][number], feature: CandidateFeature): boolean {
  return (row as unknown as Record<string, unknown>)[feature] === true;
}

interface RubricBonus {
  points?: number;
  points_source_extra?: number;
  points_br_extra?: number;
}
interface RubricFile {
  bonuses: Record<string, RubricBonus>;
}

/**
 * Pontos existentes em `rubric.json` pra uma feature candidata — `null` se a
 * feature não tem entrada (candidato genuinamente novo). `howto_br_source`
 * é caso especial: mapeia pro `points_source_extra` DENTRO da entrada
 * `howto_br` (mesmo bullet do prompt, ver rubric.json `_note`), não pra uma
 * entrada própria.
 */
function existingRubricPoints(rubric: RubricFile, feature: CandidateFeature): number | null {
  if (feature === "howto_br_source") {
    return rubric.bonuses.howto_br?.points_source_extra ?? null;
  }
  return rubric.bonuses[feature]?.points ?? null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** AUC (Mann-Whitney) — mesma definição de `shadow-validation-report.ts`, duplicada aqui só pela assinatura (`number[]` sem `null`, já filtrado pelo chamador) pra não importar um módulo `scripts/*.ts` de outro `scripts/*.ts` fora de `lib/` (convenção do projeto). */
function auc(values: ReadonlyArray<number>, labels: ReadonlyArray<boolean>): number | null {
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 0; i < values.length; i++) (labels[i] ? pos : neg).push(values[i]);
  if (pos.length === 0 || neg.length === 0) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export interface FeatureGuardrails {
  hhi: number;
  hhi_top_domain: string | null;
  hhi_rejected: boolean;
  baseline_overflow_rate: number;
  simulated_overflow_rate: number;
  domain_cap_rejected: boolean;
}

export interface CalibratedFeatureCandidate {
  feature: CandidateFeature;
  /** Coeficiente bruto ajustado (log-odds). */
  coefficient: number;
  /** e^coeficiente — "presença de X multiplica a chance de ser mantido por Y×". */
  odds_ratio: number;
  existing_rubric_points: number | null;
  proposed_points: number;
  guardrails: FeatureGuardrails;
  accepted: boolean;
  rejection_reasons: string[];
}

export interface CalibrateResult {
  status: "no_eligible_features" | "insufficient_training_data" | "all_candidates_rejected" | "candidate_produced";
  editions_analyzed: number;
  editions_skipped: Array<{ edition: string; reason: string }>;
  eligible_features: CandidateFeature[];
  holdout_requested: number;
  train_editions: number;
  holdout_editions: number;
  points_per_log_odds: number;
  points_per_log_odds_source: "anchored" | "default";
  candidates: CalibratedFeatureCandidate[];
  weights: CandidateWeights | null;
  weights_hash: string | null;
  weights_file: string | null;
  holdout_auc_real: number | null;
  holdout_auc_shadow: number | null;
  evidence_cases: CalibrationCase[];
}

/**
 * Simula, pra 1 edição, o conjunto "mantido" reordenando pelo
 * `shadow_score_alt` do candidato — mesmo TAMANHO do conjunto mantido real
 * (desempate estável pela ordem original, determinístico). `null` se a
 * edição não tiver `score_base` suficiente pra ranquear (nunca fabrica
 * ranking sobre dado ausente).
 */
function simulatedKeptRows(ed: EditionRows, weights: CandidateWeights): EditionRows["rows"] | null {
  const realKeptCount = ed.kept.filter(Boolean).length;
  if (realKeptCount === 0) return [];
  const scored = ed.rows
    .map((row, i) => ({ row, score: computeShadowScore(row, weights), i }))
    .filter((r): r is { row: EditionRows["rows"][number]; score: number; i: number } => r.score !== null);
  if (scored.length === 0) return null;
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.i - b.i));
  return scored.slice(0, realKeptCount).map((r) => r.row);
}

/**
 * Escopo do gate 2 (achado ao vivo contra o corpus real, 11/09/2026): este
 * check opera sobre o POOL APROVADO inteiro (`01-approved.json`, mesma
 * definição de "kept" de `calibration-power-report.ts` — inclui
 * runners_up/radar/use_melhor/etc, não só o que sobrevive ao RENDER final),
 * não sobre o markdown renderizado que `validate-domain-diversity.ts`
 * valida no Stage 4. Por isso as taxas observadas rodam altas em valor
 * ABSOLUTO (o pool aprovado legitimamente agrupa vários itens do mesmo
 * domínio antes da edição final trimar) — o gate aqui é sempre uma
 * comparação RELATIVA (o candidato piora a taxa vs. o baseline real?),
 * nunca uma alegação de compliance absoluta com o cap de produção (esse já
 * é validado, separadamente, em cada edição real pelo Stage 4).
 */
function domainOverflows(rows: EditionRows["rows"]): boolean {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const domain = registrableDomain(row.url);
    if (!domain) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  for (const count of counts.values()) if (count > DEFAULT_MAX_PER_DOMAIN) return true;
  return false;
}

/** Guardrails 2 (cap de domínio) e 3 (HHI) pra 1 feature, sobre TODAS as edições disponíveis (treino + holdout — os guardrails protegem contra risco do candidato, não medem poder preditivo out-of-sample). */
function evaluateGuardrails(editions: EditionRows[], feature: CandidateFeature, proposedPoints: number): FeatureGuardrails {
  // HHI sobre o suporte da feature (domínios de toda linha onde feature=true).
  const supportDomains: Array<string | null> = [];
  for (const ed of editions) {
    for (const row of ed.rows) {
      if (featureValue(row, feature)) supportDomains.push(registrableDomain(row.url));
    }
  }
  const hhiResult = computeDomainConcentration(supportDomains);
  const hhiRejected = hhiResult.hhi > HHI_REJECTION_THRESHOLD;

  // Cap de domínio: baseline real vs. simulado com o peso proposto.
  const weights: CandidateWeights = { [feature]: proposedPoints } as CandidateWeights;
  let baselineOverflows = 0;
  let simulatedOverflows = 0;
  let evaluable = 0;
  for (const ed of editions) {
    const keptRows = ed.rows.filter((_, i) => ed.kept[i]);
    if (keptRows.length === 0) continue;
    const simulated = simulatedKeptRows(ed, weights);
    if (simulated === null) continue; // sem score_base suficiente pra simular — não conta pra nenhuma das duas taxas
    evaluable++;
    if (domainOverflows(keptRows)) baselineOverflows++;
    if (domainOverflows(simulated)) simulatedOverflows++;
  }
  const baselineOverflowRate = evaluable > 0 ? baselineOverflows / evaluable : 0;
  const simulatedOverflowRate = evaluable > 0 ? simulatedOverflows / evaluable : 0;
  const domainCapRejected = simulatedOverflowRate > baselineOverflowRate;

  return {
    hhi: hhiResult.hhi,
    hhi_top_domain: hhiResult.top_domain,
    hhi_rejected: hhiRejected,
    baseline_overflow_rate: baselineOverflowRate,
    simulated_overflow_rate: simulatedOverflowRate,
    domain_cap_rejected: domainCapRejected,
  };
}

/**
 * `true` só se `aammdd` for um calendário REAL (mês 01-12, dia 01-31 pro mês
 * em questão) — mais estrita que `editionDateFromAammdd` (`scoring-
 * features.ts`), que usa `Date.UTC` e deixa dia/mês fora de faixa "rolarem"
 * silenciosamente pro mês seguinte em vez de sinalizar inválido (ex:
 * `Date.UTC(2026, 11, 99, ...)` normaliza sozinho pra uma data de 2027,
 * nunca `NaN`). Achado ao vivo (11/09/2026): `data/editions/2612/261299/`
 * é um artefato de teste/dry-run (dia "99", calendário inválido por
 * construção — plausivelmente escolhido assim de propósito, pra nunca
 * colidir com uma edição real) com `scoring-features.json`/
 * `01-approved.json` completos, então passa pelos filtros de
 * `calibration-power-report.ts`/`analyze-destaque-overrides.ts` (nenhum dos
 * dois valida o formato da data) e dominava os 5 casos de evidência (a
 * edição "mais recente" por ordenação lexicográfica de string). Mostrar
 * isso como evidência pro editor num PR de calibração real seria enganoso.
 * Escopado só à seleção de EVIDÊNCIA — não exclui a edição do fit da
 * regressão nem do relatório de poder (decisão de escopo maior, fora de
 * #7990; sinalizada à parte pra limpeza dedicada).
 */
function isPlausibleEditionDate(aammdd: string): boolean {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(aammdd);
  if (!m) return false;
  const [, , mm, dd] = m;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  return true;
}

/** Até `MAX_EVIDENCE_CASES` casos nomeados (edição+URL+ação) onde a feature calibrada apareceu — mais recentes primeiro, determinístico. */
function evidenceCasesForFeature(events: LabeledEvent[], feature: CandidateFeature): CalibrationCase[] {
  const matching = events
    .filter((e): e is LabeledEvent & { features: NonNullable<LabeledEvent["features"]> } => e.features !== null && featureValue(e.features, feature))
    .filter((e) => isPlausibleEditionDate(e.edition))
    .sort((a, b) => b.edition.localeCompare(a.edition));
  const cases: CalibrationCase[] = [];
  for (const e of matching) {
    if (cases.length >= MAX_EVIDENCE_CASES) break;
    const action =
      e.track_a === "llm_finalist_and_approved"
        ? "LLM escolheu como destaque, editor manteve"
        : e.track_a === "editor_promoted_outside_llm_finalists"
          ? "editor promoveu a destaque fora dos finalistas do LLM"
          : e.track_a === "llm_finalist_rejected_by_editor"
            ? "LLM escolheu como destaque, editor não manteve"
            : e.track_b === "bucket_kept"
              ? "manteve o mesmo bucket do pool"
              : e.track_b === "bucket_moved"
                ? `bucket movido: ${e.bucket_move?.from} → ${e.bucket_move?.to}`
                : e.track_b === "pool_cut"
                  ? "cortado do pool"
                  : e.track_b === "pool_add"
                    ? "adicionado ao pool aprovado"
                    : "evento sem rótulo Track A/B";
    cases.push({ edition: e.edition, url: e.url, action });
  }
  return cases;
}

export function calibrateScoringWeights(editionsRoot: string, rootDir: string, holdout = DEFAULT_HOLDOUT): CalibrateResult {
  const powerReport = buildPowerReport(editionsRoot);
  const eligibleFeatures = powerReport.features.filter((f) => f.passes_event_bar).map((f) => f.feature);

  const base: Pick<CalibrateResult, "editions_analyzed" | "editions_skipped"> = {
    editions_analyzed: powerReport.editions_analyzed,
    editions_skipped: powerReport.editions_skipped,
  };

  if (eligibleFeatures.length === 0) {
    return {
      ...base,
      status: "no_eligible_features",
      eligible_features: [],
      holdout_requested: holdout,
      train_editions: 0,
      holdout_editions: 0,
      points_per_log_odds: DEFAULT_POINTS_PER_LOG_ODDS,
      points_per_log_odds_source: "default",
      candidates: [],
      weights: null,
      weights_hash: null,
      weights_file: null,
      holdout_auc_real: null,
      holdout_auc_shadow: null,
      evidence_cases: [],
    };
  }

  const { editions } = loadEditionRows(editionsRoot);
  const holdoutSet = editions.slice(-holdout);
  const holdoutEditions = new Set(holdoutSet.map((e) => e.edition));
  const trainSet = editions.filter((e) => !holdoutEditions.has(e.edition));

  if (trainSet.length === 0) {
    return {
      ...base,
      status: "insufficient_training_data",
      eligible_features: eligibleFeatures,
      holdout_requested: holdout,
      train_editions: 0,
      holdout_editions: holdoutSet.length,
      points_per_log_odds: DEFAULT_POINTS_PER_LOG_ODDS,
      points_per_log_odds_source: "default",
      candidates: [],
      weights: null,
      weights_hash: null,
      weights_file: null,
      holdout_auc_real: null,
      holdout_auc_shadow: null,
      evidence_cases: [],
    };
  }

  // Design matrix sobre o TREINO apenas — holdout nunca entra aqui (guardrail 1).
  const X: number[][] = [];
  const y: number[] = [];
  for (const ed of trainSet) {
    for (let i = 0; i < ed.rows.length; i++) {
      X.push(eligibleFeatures.map((f) => (featureValue(ed.rows[i], f) ? 1 : 0)));
      y.push(ed.kept[i] ? 1 : 0);
    }
  }

  const fit = fitL2LogisticRegression(X, y, { l2: L2_LAMBDA });

  // Escala log-odds → pontos: âncora empírica quando disponível, senão default documentado.
  const rubricPath = join(rootDir, "context", "scoring", "rubric.json");
  const rubric: RubricFile = existsSync(rubricPath) ? JSON.parse(readFileSync(rubricPath, "utf8")) : { bonuses: {} };
  const anchorRatios: number[] = [];
  eligibleFeatures.forEach((f, j) => {
    const existing = existingRubricPoints(rubric, f);
    if (existing !== null && fit.coefficients[j] !== 0) anchorRatios.push(existing / fit.coefficients[j]);
  });
  const anchoredScale = median(anchorRatios);
  const pointsPerLogOdds = anchoredScale ?? DEFAULT_POINTS_PER_LOG_ODDS;
  const pointsPerLogOddsSource: "anchored" | "default" = anchoredScale !== null ? "anchored" : "default";

  const candidates: CalibratedFeatureCandidate[] = eligibleFeatures.map((feature, j) => {
    const coefficient = fit.coefficients[j];
    const proposedPoints = Math.round(coefficient * pointsPerLogOdds);
    const guardrails = evaluateGuardrails(editions, feature, proposedPoints);
    const rejectionReasons: string[] = [];
    if (proposedPoints === 0) rejectionReasons.push("coeficiente ajustado produz 0 pontos propostos — sem efeito prático pra calibrar.");
    if (guardrails.hhi_rejected) {
      rejectionReasons.push(
        `gate de concentração de fonte: HHI do suporte (${guardrails.hhi.toFixed(0)}) excede o limiar de ${HHI_REJECTION_THRESHOLD} (top domínio: ${guardrails.hhi_top_domain ?? "n/d"}).`,
      );
    }
    if (guardrails.domain_cap_rejected) {
      rejectionReasons.push(
        `cap de 2 URLs/domínio (#5735): taxa simulada de estouro (${(guardrails.simulated_overflow_rate * 100).toFixed(1)}%) excede a taxa real observada (${(guardrails.baseline_overflow_rate * 100).toFixed(1)}%).`,
      );
    }
    return {
      feature,
      coefficient,
      odds_ratio: Math.exp(coefficient),
      existing_rubric_points: existingRubricPoints(rubric, feature),
      proposed_points: proposedPoints,
      guardrails,
      accepted: rejectionReasons.length === 0,
      rejection_reasons: rejectionReasons,
    };
  });

  const accepted = candidates.filter((c) => c.accepted);
  if (accepted.length === 0) {
    return {
      ...base,
      status: "all_candidates_rejected",
      eligible_features: eligibleFeatures,
      holdout_requested: holdout,
      train_editions: trainSet.length,
      holdout_editions: holdoutSet.length,
      points_per_log_odds: pointsPerLogOdds,
      points_per_log_odds_source: pointsPerLogOddsSource,
      candidates,
      weights: null,
      weights_hash: null,
      weights_file: null,
      holdout_auc_real: null,
      holdout_auc_shadow: null,
      evidence_cases: [],
    };
  }

  const weights: CandidateWeights = Object.fromEntries(accepted.map((c) => [c.feature, c.proposed_points])) as CandidateWeights;
  const hash = weightsHash(weights);

  // AUC de holdout — real (score) vs. shadow (candidato) — mesma definição de shadow-validation-report.ts, reimplementada localmente (ver `auc()` acima) pra este script não depender de scoring-shadow.json pré-computado.
  const realValues: number[] = [];
  const realLabels: boolean[] = [];
  const shadowValues: number[] = [];
  const shadowLabels: boolean[] = [];
  for (const ed of holdoutSet) {
    for (let i = 0; i < ed.rows.length; i++) {
      const row = ed.rows[i];
      if (typeof row.score === "number") {
        realValues.push(row.score);
        realLabels.push(ed.kept[i]);
      }
      const shadow = computeShadowScore(row, weights);
      if (shadow !== null) {
        shadowValues.push(shadow);
        shadowLabels.push(ed.kept[i]);
      }
    }
  }

  const events = analyzeAllEditions(editionsRoot).events;
  const evidenceCases = evidenceCasesForFeature(events, accepted[0].feature);

  return {
    ...base,
    status: "candidate_produced",
    eligible_features: eligibleFeatures,
    holdout_requested: holdout,
    train_editions: trainSet.length,
    holdout_editions: holdoutSet.length,
    points_per_log_odds: pointsPerLogOdds,
    points_per_log_odds_source: pointsPerLogOddsSource,
    candidates,
    weights,
    weights_hash: hash,
    weights_file: null, // preenchido por writeCandidateWeightsFile() se --write
    holdout_auc_real: auc(realValues, realLabels),
    holdout_auc_shadow: auc(shadowValues, shadowLabels),
    evidence_cases: evidenceCases,
  };
}

/** Escreve `context/scoring/candidate-weights/{hash}.json` — mesmo formato de `CandidateWeightsFile` que `compute-shadow-scores.ts` já consome (#7977). Retorna o path relativo escrito. */
export function writeCandidateWeightsFile(rootDir: string, result: CalibrateResult): string {
  if (!result.weights || !result.weights_hash) {
    throw new Error("writeCandidateWeightsFile: result.weights/weights_hash ausentes — chame calibrateScoringWeights primeiro e confira result.status === 'candidate_produced'.");
  }
  const accepted = result.candidates.filter((c) => c.accepted);
  const rationale = [
    `Saída de calibrate-scoring-weights.ts (#7990) — regressão logística L2 sobre ${result.train_editions} edições de treino (${result.holdout_editions} em holdout, nunca usadas no fit).`,
    `Feature(s) calibrada(s): ${accepted.map((c) => `${c.feature} (coef=${c.coefficient.toFixed(4)}, odds_ratio=${c.odds_ratio.toFixed(3)}, proposto=${c.proposed_points}pt${c.existing_rubric_points !== null ? `, rubrico atual=${c.existing_rubric_points}pt` : ", sem bônus prévio no rubrico"})`).join("; ")}.`,
    `Escala log-odds→pontos: ${result.points_per_log_odds.toFixed(2)} (${result.points_per_log_odds_source === "anchored" ? "âncora empírica de feature(s) com ponto existente em rubric.json" : "default documentado — nenhuma feature elegível nesta rodada tinha âncora"}).`,
    `AUC holdout: real=${result.holdout_auc_real?.toFixed(3) ?? "n/d"} shadow=${result.holdout_auc_shadow?.toFixed(3) ?? "n/d"}.`,
  ].join(" ");

  const dir = join(rootDir, "context", "scoring", "candidate-weights");
  mkdirSync(dir, { recursive: true });
  const file: CandidateWeightsFile = {
    label: `calibrate-scoring-weights: ${accepted.map((c) => c.feature).join("+")}`,
    created_at: new Date().toISOString(),
    rationale,
    weights: result.weights,
  };
  const relPath = join("context", "scoring", "candidate-weights", `${result.weights_hash}.json`);
  writeFileSync(join(rootDir, relPath), JSON.stringify(file, null, 2) + "\n", "utf8");
  return relPath.replace(/\\/g, "/");
}

function formatReport(result: CalibrateResult): string {
  const lines: string[] = [];
  lines.push(`[calibrate-scoring-weights] ${result.editions_analyzed} edições analisadas — status: ${result.status}`);
  if (result.editions_skipped.length > 0) {
    lines.push(`  ${result.editions_skipped.length} edição(ões) pulada(s):`);
    for (const s of result.editions_skipped) lines.push(`    ${s.edition}: ${s.reason}`);
  }
  lines.push(`  features elegíveis (passam a barra de evidência): ${result.eligible_features.join(", ") || "(nenhuma)"}`);
  if (result.status === "no_eligible_features") {
    lines.push("  nenhuma feature passa a barra hoje — nada pra calibrar. Rodar calibration-power-report.ts pra ver o detalhe.");
    return lines.join("\n");
  }
  if (result.status === "insufficient_training_data") {
    lines.push(`  corpus insuficiente: só ${result.holdout_editions} edições no total, todas reservadas pro holdout (${result.holdout_requested}) — 0 sobram pra treino.`);
    return lines.join("\n");
  }
  lines.push(`  treino: ${result.train_editions} edições  holdout: ${result.holdout_editions} edições  escala log-odds→pontos: ${result.points_per_log_odds.toFixed(2)} (${result.points_per_log_odds_source})`);
  lines.push("");
  for (const c of result.candidates) {
    lines.push(`  ${c.feature}: coef=${c.coefficient.toFixed(4)} odds_ratio=${c.odds_ratio.toFixed(3)} proposto=${c.proposed_points}pt (rubrico atual: ${c.existing_rubric_points ?? "nenhum"})`);
    lines.push(`    HHI(suporte)=${c.guardrails.hhi.toFixed(0)} (top=${c.guardrails.hhi_top_domain ?? "n/d"})  cap-overflow real=${(c.guardrails.baseline_overflow_rate * 100).toFixed(1)}% simulado=${(c.guardrails.simulated_overflow_rate * 100).toFixed(1)}%`);
    lines.push(`    ${c.accepted ? "✅ ACEITO" : "❌ REJEITADO: " + c.rejection_reasons.join(" | ")}`);
  }
  lines.push("");
  if (result.status === "all_candidates_rejected") {
    lines.push("  TODOS os candidatos rejeitados pelos guardrails — nenhum arquivo de pesos gerado.");
  } else if (result.status === "candidate_produced") {
    lines.push(`  candidato(s) aceito(s) → hash ${result.weights_hash}`);
    lines.push(`  AUC holdout: real=${result.holdout_auc_real?.toFixed(3) ?? "n/d"}  shadow=${result.holdout_auc_shadow?.toFixed(3) ?? "n/d"}`);
    lines.push(`  ${result.evidence_cases.length} caso(s) de evidência coletado(s) pra evidence report.`);
    if (result.weights_file) lines.push(`  escrito em: ${result.weights_file}`);
  }
  return lines.join("\n");
}

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const editionsRoot = resolve(ROOT, values["editions-dir"] ?? "data/editions");
  const holdout = values["holdout"] ? Number(values["holdout"]) : DEFAULT_HOLDOUT;
  const json = flags.has("json");
  const write = flags.has("write");

  if (!Number.isInteger(holdout) || holdout <= 0) {
    console.error(`--holdout precisa ser um inteiro positivo, recebido: ${values["holdout"]}`);
    process.exit(2);
  }

  const result = calibrateScoringWeights(editionsRoot, ROOT, holdout);
  if (write && result.status === "candidate_produced") {
    result.weights_file = writeCandidateWeightsFile(ROOT, result);
  }

  console.log(json ? JSON.stringify(result, null, 2) : formatReport(result));
}
