#!/usr/bin/env tsx
/**
 * scripts/calibrate-track-a-weights.ts (#7980, Fase 6 da #7972 — estende
 * o mecanismo de `calibrate-scoring-weights.ts`/#7990 Track B ao Track A)
 *
 * Regressão logística L2 (`scripts/lib/logistic-regression.ts`, mesmo
 * módulo puro reusado de Track B) aprendendo um coeficiente por feature
 * candidata do Track A (`scripts/lib/track-a-features.ts`) que JÁ passa a
 * barra de evidência MAIS ALTA do Track A
 * (`calibration-power-report-track-a.ts`, ≥30 eventos/lado + ≥40
 * edições-calendário + ≥2 janelas de validação consistentes).
 *
 * Read-only: NUNCA escreve em `.claude/agents/scorer-select.md`,
 * `scripts/lib/coverage-bonus.ts`, `scripts/lib/audience-affinity.ts` nem
 * em nenhum arquivo de produção. A única escrita (com `--write`) é um
 * NOVO arquivo em `context/scoring/candidate-weights-track-a/` — diretório
 * PRÓPRIO, separado de `context/scoring/candidate-weights/` (Track B),
 * pra nunca confundir de qual track um arquivo de pesos candidato veio.
 * Abrir PR de verdade (draft, `needs-editor-signoff`) é ação de FORA
 * deste script — mesma separação de responsabilidade de Track B (REGRA
 * DE OURO, #7972).
 *
 * ## Guardrails (2 de 3 dos de Track B — 3º explicitamente fora de escopo)
 *
 * 1. **Holdout nunca usado em treino** — as `DEFAULT_HOLDOUT_TRACK_A`
 *    edições cronologicamente mais recentes da população Track A (ver
 *    `calibration-power-report-track-a.ts::buildTrackAPopulation`) NUNCA
 *    entram no design matrix do fit; servem só pra medir AUC out-of-
 *    sample.
 * 2. **Gate de concentração de fonte (HHI)** — igual a Track B:
 *    `computeDomainConcentration` sobre os domínios de todo evento onde a
 *    feature é `true` (o "suporte"); rejeitado se HHI > `HHI_REJECTION_THRESHOLD`.
 * 3. **Poder preditivo mínimo no holdout (AUC)** — AUC (Mann-Whitney) do
 *    shadow score desta feature isolada, calculado só sobre o holdout.
 *    Rejeitado se AUC ≤ `AUC_REJECTION_THRESHOLD` (0.5).
 *
 * **O 3º guardrail de Track B (cap de 2 URLs/domínio, #5735) NÃO tem
 * análogo aqui, de propósito, não por omissão:** aquele guardrail simula
 * "se re-ranqueássemos o POOL INTEIRO por shadow score, o cap de domínio
 * estouraria mais que o baseline real?" — uma pergunta sobre RANKING de
 * um conjunto amplo (dezenas de itens por edição). A população do Track A
 * aqui é estruturalmente diferente: são os ~6 candidatos que o
 * `scorer-select` JÁ tinha escolhido como finalistas antes de qualquer
 * recalibração — o cap de domínio é aplicado (e continua sendo aplicado,
 * inalterado por esta calibração) no RENDER final da edição
 * (`validate-domain-diversity.ts`, Stage 4), sobre o conjunto final de
 * destaques+pool, não sobre a sub-seleção de 6 finalistas do LLM. Recriar
 * esse guardrail aqui simularia uma pergunta que esta calibração não tem
 * como responder (ela nunca re-ranqueia o pool inteiro, só repondera os
 * ~6 finalistas já escolhidos) — decisão de escopo registrada aqui, não
 * um guardrail esquecido.
 *
 * ## De log-odds pra pontos do rubrico
 *
 * Mesma conversão de Track B: âncora empírica quando a feature já tem
 * valor de pontos comparável (rubric.json pra `primary_source`/
 * `hands_on`/`academy`/`howto_br`(`_source`); `COVERAGE_BONUS_PER_SOURCE`
 * de `coverage-bonus.ts` pra `coverage_bonus_present`, já que esse bônus
 * não vive em rubric.json), senão `DEFAULT_POINTS_PER_LOG_ODDS_TRACK_A`
 * (mesmo valor de Track B, 10 — nenhuma razão pra divergir sem dado que
 * justifique).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { buildTrackAPowerReport, buildTrackAPopulation, type TrackAEditionRows } from "./calibration-power-report-track-a.ts";
import { TRACK_A_CANDIDATE_FEATURES, trackAFeatureValue, type TrackACandidateFeature } from "./lib/track-a-features.ts";
import { COVERAGE_BONUS_PER_SOURCE } from "./lib/coverage-bonus.ts";
import { analyzeAllEditions, type LabeledEvent } from "./analyze-destaque-overrides.ts";
import { fitL2LogisticRegression } from "./lib/logistic-regression.ts";
import { computeDomainConcentration } from "./lib/source-concentration.ts";
import { registrableDomain } from "./lib/registrable-domain.ts";
import { computeAuc } from "./shadow-validation-report.ts";
import { isPlausibleEditionDate } from "./calibrate-scoring-weights.ts";
import type { CalibrationCase } from "./lib/calibration-evidence-report.ts";

const ROOT = resolve(import.meta.dirname, "..");

export const DEFAULT_HOLDOUT_TRACK_A = 25; // mesmo valor de Track B (calibrate-scoring-weights.ts::DEFAULT_HOLDOUT) — nenhuma razão medida pra divergir
export const HHI_REJECTION_THRESHOLD = 2500; // mesmo limiar de Track B (source-concentration.ts)
export const AUC_REJECTION_THRESHOLD = 0.5;
export const DEFAULT_POINTS_PER_LOG_ODDS_TRACK_A = 10;
const L2_LAMBDA = 0.01; // mesmo racional medido de logistic-regression.ts::DEFAULT_L2
const MAX_EVIDENCE_CASES = 5;

interface RubricBonus {
  points?: number;
  points_source_extra?: number;
}
interface RubricFile {
  bonuses: Record<string, RubricBonus>;
}

/** Pontos existentes pra ancorar a escala log-odds→pontos — rubric.json pras 5 features com bônus fixo, `COVERAGE_BONUS_PER_SOURCE` pra `coverage_bonus_present` (não vive em rubric.json, é constante própria de coverage-bonus.ts). */
function existingPointsAnchor(rubric: RubricFile, feature: TrackACandidateFeature): number | null {
  if (feature === "coverage_bonus_present") return COVERAGE_BONUS_PER_SOURCE;
  if (rubric.bonuses === null || typeof rubric.bonuses !== "object") {
    throw new Error(`existingPointsAnchor: rubric.bonuses não é um objeto (${typeof rubric.bonuses}) — rubric.json malformado?`);
  }
  if (feature === "howto_br_source") return rubric.bonuses.howto_br?.points_source_extra ?? null;
  return rubric.bonuses[feature]?.points ?? null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export type TrackACandidateWeights = Readonly<Partial<Record<TrackACandidateFeature, number>>>;

export interface TrackACandidateWeightsFile {
  label: string;
  created_at: string;
  rationale: string;
  weights: TrackACandidateWeights;
}

/** Hash de conteúdo determinístico — mesmo formato de `shadow-score.ts::weightsHash` (SHA-256 hex do JSON canônico, chaves ordenadas), reimplementado localmente em vez de importado: o tipo de `weights` aqui é `TrackACandidateFeature`, não `CandidateFeature` de Track B, e a função de Track B está tipada contra aquela união — reusar exigiria alargar o tipo público de um módulo de OUTRO track só pra este import, o que acopla os dois tracks por um detalhe de hashing. */
export function trackAWeightsHash(weights: TrackACandidateWeights): string {
  const canonical = JSON.stringify(weights, Object.keys(weights).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function shadowScoreTrackA(event: LabeledEvent, weights: TrackACandidateWeights): number | null {
  if (!event.features || typeof event.features.score_base !== "number") return null;
  let bonus = 0;
  for (const [feature, weight] of Object.entries(weights)) {
    if (trackAFeatureValue(event.features, feature as TrackACandidateFeature)) bonus += weight as number;
  }
  return event.features.score_base + bonus;
}

export interface TrackAFeatureGuardrails {
  hhi: number;
  hhi_top_domain: string | null;
  hhi_unassessable: boolean;
  hhi_rejected: boolean;
  holdout_auc: number | null;
  auc_unassessable: boolean;
  auc_rejected: boolean;
}

export interface CalibratedTrackAFeatureCandidate {
  feature: TrackACandidateFeature;
  coefficient: number;
  odds_ratio: number;
  existing_points_anchor: number | null;
  proposed_points: number;
  guardrails: TrackAFeatureGuardrails;
  accepted: boolean;
  rejection_reasons: string[];
}

export interface CalibrateTrackAResult {
  status: "no_eligible_features" | "insufficient_training_data" | "all_candidates_rejected" | "candidate_produced";
  editions_analyzed: number;
  eligible_features: TrackACandidateFeature[];
  holdout_requested: number;
  train_editions: number;
  holdout_editions: number;
  points_per_log_odds: number;
  points_per_log_odds_source: "anchored" | "default";
  candidates: CalibratedTrackAFeatureCandidate[];
  weights: TrackACandidateWeights | null;
  weights_hash: string | null;
  weights_file: string | null;
  holdout_auc_shadow: number | null;
  evidence_cases: CalibrationCase[];
}

function evaluateTrackAGuardrails(
  editions: TrackAEditionRows[],
  feature: TrackACandidateFeature,
  proposedPoints: number,
  holdoutEditions: TrackAEditionRows[],
): TrackAFeatureGuardrails {
  const supportDomains: Array<string | null> = [];
  for (const ed of editions) {
    for (const event of ed.events) {
      if (event.features && trackAFeatureValue(event.features, feature)) supportDomains.push(registrableDomain(event.url));
    }
  }
  const hhiResult = computeDomainConcentration(supportDomains);
  const hhiUnassessable = hhiResult.domain_count === 0;
  const hhiRejected = hhiUnassessable || hhiResult.hhi > HHI_REJECTION_THRESHOLD;

  const weights: TrackACandidateWeights = { [feature]: proposedPoints };
  const aucValues: number[] = [];
  const aucLabels: boolean[] = [];
  for (const ed of holdoutEditions) {
    for (let i = 0; i < ed.events.length; i++) {
      const shadow = shadowScoreTrackA(ed.events[i], weights);
      if (shadow !== null) {
        aucValues.push(shadow);
        aucLabels.push(ed.approved[i]);
      }
    }
  }
  const holdoutAuc = computeAuc(aucValues, aucLabels);
  const aucUnassessable = holdoutAuc === null;
  const aucRejected = aucUnassessable || holdoutAuc <= AUC_REJECTION_THRESHOLD;

  return {
    hhi: hhiResult.hhi,
    hhi_top_domain: hhiResult.top_domain,
    hhi_unassessable: hhiUnassessable,
    hhi_rejected: hhiRejected,
    holdout_auc: holdoutAuc,
    auc_unassessable: aucUnassessable,
    auc_rejected: aucRejected,
  };
}

function describeTrackAEvent(e: LabeledEvent): string {
  return e.track_a === "llm_finalist_and_approved" ? "LLM escolheu como destaque, editor manteve" : "LLM escolheu como destaque, editor não manteve";
}

/** Até `MAX_EVIDENCE_CASES` casos nomeados (edição+URL+ação) — mesmo padrão de `calibrate-scoring-weights.ts::evidenceCasesForFeatures`, restrito à população Track A e filtrando datas implausíveis (`isPlausibleEditionDate`, reusado — mesmo achado ao vivo do #7990 sobre `data/editions/2612/261299/`). */
function evidenceCasesForTrackAFeatures(events: LabeledEvent[], features: readonly TrackACandidateFeature[]): CalibrationCase[] {
  const multiFeature = features.length > 1;
  const matching = events
    .filter((e) => e.track_a === "llm_finalist_and_approved" || e.track_a === "llm_finalist_rejected_by_editor")
    .filter((e): e is LabeledEvent & { features: NonNullable<LabeledEvent["features"]> } => e.features !== null)
    .filter((e) => isPlausibleEditionDate(e.edition))
    .flatMap((e) => features.filter((f) => trackAFeatureValue(e.features, f)).map((f) => ({ event: e, feature: f })))
    .sort((a, b) => (b.event.edition !== a.event.edition ? b.event.edition.localeCompare(a.event.edition) : a.feature.localeCompare(b.feature)));

  const cases: CalibrationCase[] = [];
  for (const { event, feature } of matching) {
    if (cases.length >= MAX_EVIDENCE_CASES) break;
    const action = multiFeature ? `${describeTrackAEvent(event)} (feature: ${feature})` : describeTrackAEvent(event);
    cases.push({ edition: event.edition, url: event.url, action });
  }
  return cases;
}

export function calibrateTrackAWeights(editionsRoot: string, rootDir: string, holdout = DEFAULT_HOLDOUT_TRACK_A): CalibrateTrackAResult {
  // População construída 1 VEZ e reusada no power report — achado de review
  // do #7980 (P3, eficiência): antes disto, `buildTrackAPowerReport` e
  // `buildTrackAPopulation` liam/parseavam TODA edição do disco 2 vezes
  // independentes na mesma chamada desta função.
  const population = buildTrackAPopulation(editionsRoot);
  const powerReport = buildTrackAPowerReport(editionsRoot, undefined, population);
  const eligibleFeatures = powerReport.features.filter((f) => f.passes_evidence_bar_track_a).map((f) => f.feature);

  const base = { editions_analyzed: powerReport.editions_analyzed };

  if (eligibleFeatures.length === 0) {
    return {
      ...base,
      status: "no_eligible_features",
      eligible_features: [],
      holdout_requested: holdout,
      train_editions: 0,
      holdout_editions: 0,
      points_per_log_odds: DEFAULT_POINTS_PER_LOG_ODDS_TRACK_A,
      points_per_log_odds_source: "default",
      candidates: [],
      weights: null,
      weights_hash: null,
      weights_file: null,
      holdout_auc_shadow: null,
      evidence_cases: [],
    };
  }

  const { editions } = population;
  const holdoutSet = editions.slice(-holdout);
  const holdoutEditionSet = new Set(holdoutSet.map((e) => e.edition));
  const trainSet = editions.filter((e) => !holdoutEditionSet.has(e.edition));

  if (trainSet.length === 0) {
    return {
      ...base,
      status: "insufficient_training_data",
      eligible_features: eligibleFeatures,
      holdout_requested: holdout,
      train_editions: 0,
      holdout_editions: holdoutSet.length,
      points_per_log_odds: DEFAULT_POINTS_PER_LOG_ODDS_TRACK_A,
      points_per_log_odds_source: "default",
      candidates: [],
      weights: null,
      weights_hash: null,
      weights_file: null,
      holdout_auc_shadow: null,
      evidence_cases: [],
    };
  }

  const X: number[][] = [];
  const y: number[] = [];
  for (const ed of trainSet) {
    for (let i = 0; i < ed.events.length; i++) {
      X.push(eligibleFeatures.map((f) => (trackAFeatureValue(ed.events[i].features!, f) ? 1 : 0)));
      y.push(ed.approved[i] ? 1 : 0);
    }
  }

  const fit = fitL2LogisticRegression(X, y, { l2: L2_LAMBDA });

  const rubricPath = join(rootDir, "context", "scoring", "rubric.json");
  const rubric: RubricFile = existsSync(rubricPath) ? JSON.parse(readFileSync(rubricPath, "utf8")) : { bonuses: {} };
  const anchorRatios: number[] = [];
  eligibleFeatures.forEach((f, j) => {
    const existing = existingPointsAnchor(rubric, f);
    if (existing !== null && fit.coefficients[j] !== 0) anchorRatios.push(existing / fit.coefficients[j]);
  });
  const anchoredScale = median(anchorRatios);
  const pointsPerLogOdds = anchoredScale ?? DEFAULT_POINTS_PER_LOG_ODDS_TRACK_A;
  const pointsPerLogOddsSource: "anchored" | "default" = anchoredScale !== null ? "anchored" : "default";

  const candidates: CalibratedTrackAFeatureCandidate[] = eligibleFeatures.map((feature, j) => {
    const coefficient = fit.coefficients[j];
    const proposedPoints = Math.round(coefficient * pointsPerLogOdds);
    const guardrails = evaluateTrackAGuardrails(editions, feature, proposedPoints, holdoutSet);
    const rejectionReasons: string[] = [];
    if (proposedPoints === 0) rejectionReasons.push("coeficiente ajustado produz 0 pontos propostos — sem efeito prático pra calibrar.");
    if (guardrails.hhi_unassessable) {
      rejectionReasons.push("gate de concentração de fonte: NÃO AVALIÁVEL — nenhum domínio parseável no suporte da feature (fail-closed).");
    } else if (guardrails.hhi_rejected) {
      rejectionReasons.push(`gate de concentração de fonte: HHI do suporte (${guardrails.hhi.toFixed(0)}) excede o limiar de ${HHI_REJECTION_THRESHOLD} (top domínio: ${guardrails.hhi_top_domain ?? "n/d"}).`);
    }
    if (guardrails.auc_unassessable) {
      rejectionReasons.push("poder preditivo: NÃO AVALIÁVEL — AUC de holdout indefinida (fail-closed).");
    } else if (guardrails.auc_rejected) {
      rejectionReasons.push(`poder preditivo: AUC de holdout (${guardrails.holdout_auc!.toFixed(3)}) não supera ${AUC_REJECTION_THRESHOLD} — não prediz melhor que aleatório fora da amostra.`);
    }
    return {
      feature,
      coefficient,
      odds_ratio: Math.exp(coefficient),
      existing_points_anchor: existingPointsAnchor(rubric, feature),
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
      holdout_auc_shadow: null,
      evidence_cases: [],
    };
  }

  const weights: TrackACandidateWeights = Object.fromEntries(accepted.map((c) => [c.feature, c.proposed_points]));
  const hash = trackAWeightsHash(weights);

  const shadowValues: number[] = [];
  const shadowLabels: boolean[] = [];
  for (const ed of holdoutSet) {
    for (let i = 0; i < ed.events.length; i++) {
      const shadow = shadowScoreTrackA(ed.events[i], weights);
      if (shadow !== null) {
        shadowValues.push(shadow);
        shadowLabels.push(ed.approved[i]);
      }
    }
  }

  const events = analyzeAllEditions(editionsRoot).events;
  const evidenceCases = evidenceCasesForTrackAFeatures(events, accepted.map((c) => c.feature));

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
    weights_file: null,
    holdout_auc_shadow: computeAuc(shadowValues, shadowLabels),
    evidence_cases: evidenceCases,
  };
}

/** Escreve `context/scoring/candidate-weights-track-a/{hash}.json` — diretório PRÓPRIO do Track A (nunca `context/scoring/candidate-weights/`, esse é de Track B). */
export function writeTrackACandidateWeightsFile(rootDir: string, result: CalibrateTrackAResult): string {
  if (!result.weights || !result.weights_hash) {
    throw new Error("writeTrackACandidateWeightsFile: result.weights/weights_hash ausentes — chame calibrateTrackAWeights primeiro e confira result.status === 'candidate_produced'.");
  }
  const accepted = result.candidates.filter((c) => c.accepted);
  const rationale = [
    `Saída de calibrate-track-a-weights.ts (#7980) — regressão logística L2 sobre ${result.train_editions} edições de treino (${result.holdout_editions} em holdout, nunca usadas no fit) da população Track A (finalistas do LLM aprovados/rejeitados pelo editor).`,
    `Feature(s) calibrada(s): ${accepted.map((c) => `${c.feature} (coef=${c.coefficient.toFixed(4)}, odds_ratio=${c.odds_ratio.toFixed(3)}, proposto=${c.proposed_points}pt${c.existing_points_anchor !== null ? `, âncora atual=${c.existing_points_anchor}pt` : ", sem âncora prévia"})`).join("; ")}.`,
    `Escala log-odds→pontos: ${result.points_per_log_odds.toFixed(2)} (${result.points_per_log_odds_source === "anchored" ? "âncora empírica" : "default documentado"}).`,
    `AUC holdout (shadow): ${result.holdout_auc_shadow?.toFixed(3) ?? "n/d"}.`,
  ].join(" ");

  const dir = join(rootDir, "context", "scoring", "candidate-weights-track-a");
  mkdirSync(dir, { recursive: true });
  const file: TrackACandidateWeightsFile = {
    label: `calibrate-track-a-weights: ${accepted.map((c) => c.feature).join("+")}`,
    created_at: new Date().toISOString(),
    rationale,
    weights: result.weights,
  };
  const relPath = join("context", "scoring", "candidate-weights-track-a", `${result.weights_hash}.json`);
  writeFileSync(join(rootDir, relPath), JSON.stringify(file, null, 2) + "\n", "utf8");
  return relPath.replace(/\\/g, "/");
}

function formatReport(result: CalibrateTrackAResult): string {
  const lines: string[] = [];
  lines.push(`[calibrate-track-a-weights] ${result.editions_analyzed} edições com evento(s) Track A — status: ${result.status}`);
  lines.push(`  features elegíveis (passam a barra de evidência do Track A): ${result.eligible_features.join(", ") || "(nenhuma)"}`);
  if (result.status === "no_eligible_features") {
    lines.push("  nenhuma feature passa a barra hoje — nada pra calibrar. Rodar calibration-power-report-track-a.ts pra ver o detalhe.");
    return lines.join("\n");
  }
  if (result.status === "insufficient_training_data") {
    lines.push(`  corpus insuficiente: só ${result.holdout_editions} edições no total, todas reservadas pro holdout (${result.holdout_requested}) — 0 sobram pra treino.`);
    return lines.join("\n");
  }
  lines.push(`  treino: ${result.train_editions} edições  holdout: ${result.holdout_editions} edições  escala log-odds→pontos: ${result.points_per_log_odds.toFixed(2)} (${result.points_per_log_odds_source})`);
  lines.push("");
  for (const c of result.candidates) {
    lines.push(`  ${c.feature}: coef=${c.coefficient.toFixed(4)} odds_ratio=${c.odds_ratio.toFixed(3)} proposto=${c.proposed_points}pt (âncora: ${c.existing_points_anchor ?? "nenhuma"})`);
    lines.push(`    HHI(suporte)=${c.guardrails.hhi_unassessable ? "N/A" : c.guardrails.hhi.toFixed(0)} (top=${c.guardrails.hhi_top_domain ?? "n/d"})  AUC(holdout)=${c.guardrails.auc_unassessable ? "N/A" : c.guardrails.holdout_auc!.toFixed(3)}`);
    lines.push(`    ${c.accepted ? "✅ ACEITO" : "❌ REJEITADO: " + c.rejection_reasons.join(" | ")}`);
  }
  lines.push("");
  if (result.status === "all_candidates_rejected") {
    lines.push("  TODOS os candidatos rejeitados pelos guardrails — nenhum arquivo de pesos gerado.");
  } else if (result.status === "candidate_produced") {
    lines.push(`  candidato(s) aceito(s) → hash ${result.weights_hash}`);
    lines.push(`  AUC holdout (shadow): ${result.holdout_auc_shadow?.toFixed(3) ?? "n/d"}`);
    lines.push(`  ${result.evidence_cases.length} caso(s) de evidência coletado(s).`);
    if (result.weights_file) lines.push(`  escrito em: ${result.weights_file}`);
  }
  return lines.join("\n");
}

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const editionsRoot = resolve(ROOT, values["editions-dir"] ?? "data/editions");
  const holdout = values["holdout"] ? Number(values["holdout"]) : DEFAULT_HOLDOUT_TRACK_A;
  const json = flags.has("json");
  const write = flags.has("write");

  if (!Number.isInteger(holdout) || holdout <= 0) {
    console.error(`--holdout precisa ser um inteiro positivo, recebido: ${values["holdout"]}`);
    process.exit(2);
  }

  const result = calibrateTrackAWeights(editionsRoot, ROOT, holdout);
  if (write && result.status === "candidate_produced") {
    result.weights_file = writeTrackACandidateWeightsFile(ROOT, result);
  }

  console.log(json ? JSON.stringify(result, null, 2) : formatReport(result));
}
