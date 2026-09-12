#!/usr/bin/env tsx
/**
 * scripts/calibration-power-report-track-a.ts (#7980, Fase 6 da #7972 —
 * estende a Camada 2 da #7972 ao Track A)
 *
 * Relatório read-only análogo a `calibration-power-report.ts` (Track B),
 * mas escopado à população e à barra de evidência PRÓPRIAS do Track A
 * (seleção de destaque) — ver `scripts/lib/track-a-features.ts` pro
 * conjunto de features candidatas e a justificativa de escopo.
 *
 * ## População (diferente de Track B)
 *
 * Track B mede "sobrevive em QUALQUER bucket de `01-approved.json`"
 * (`calibration-power-report.ts::keptUrlsFromApproved`) — sinal de
 * retenção no POOL inteiro. Track A precisa de um sinal mais estreito:
 * "dado que o LLM (`scorer-select`) já escolheu este candidato como 1 dos
 * 6 destaques propostos em `01-categorized.json.highlights`, o editor
 * manteve como destaque em `01-approved.json.highlights`, ou rejeitou?"
 * — exatamente os rótulos `llm_finalist_and_approved` /
 * `llm_finalist_rejected_by_editor` que `analyze-destaque-overrides.ts`
 * (#7976) já produz. `editor_promoted_outside_llm_finalists` fica de fora
 * da população de TREINO/TESTE estatístico (não existe um "par" com feature
 * presente/ausente comparável — o LLM nunca escolheu esses candidatos, então
 * não há como isolar o efeito da feature sobre a decisão do ALGORITMO) mas
 * é reportado como estatística DIAGNÓSTICA separada, nunca usado pro
 * p-valor/diff — sinal de "o LLM está sub-ponderando esta feature", útil
 * de ler mas fora do escopo do teste estatístico formal.
 *
 * ## Barra de evidência MAIS ALTA que Track B (#7980)
 *
 * Track B (`calibration-power-report.ts`) já exige ≥30 eventos por lado E
 * ≥40 edições-calendário avaliáveis (mitigação C-1 do design da #7972) —
 * mas só REPORTA a consistência forward-chaining (1 corte early/late),
 * nunca a usa como gate duro (`passes_event_bar` de Track B ignora
 * `forward_chaining_consistent`). Track A exige os MESMOS pisos numéricos
 * de eventos/edições — MAS além disso, ≥2 JANELAS de validação forward-
 * chaining consecutivas (não 1) precisam concordar em sinal — um gate
 * duro que Track B não tem. `passes_evidence_bar_track_a` só é `true`
 * quando os 2 requisitos passam JUNTOS.
 */

import { resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { analyzeAllEditions, type LabeledEvent } from "./analyze-destaque-overrides.ts";
import { TRACK_A_CANDIDATE_FEATURES, trackAFeatureValue, type TrackACandidateFeature } from "./lib/track-a-features.ts";
import { mulberry32, shuffleInPlace } from "./lib/permutation-test.ts";

const ROOT = resolve(import.meta.dirname, "..");

/** Mesmo piso de Track B (#7972 mitigação C-1) — Track A não afrouxa este número, só ADICIONA o gate de janelas abaixo. */
export const TRACK_A_EVENT_COUNT_MIN = 30;
/** Mesmo piso de Track B. */
export const TRACK_A_EVALUABLE_EDITIONS_MIN = 40;
/** Nº de janelas cronológicas em que as edições avaliáveis são divididas pro forward-chaining — Track A exige consistência de sinal em ≥2 delas (não só early/late = 2 metades de 1 corte único, que é o que Track B já faz informativamente). 3 janelas dão margem pra medir consistência em MAIS de 1 fronteira temporal. */
const VALIDATION_WINDOWS = 3;
/** Quantas das `VALIDATION_WINDOWS` precisam ter o MESMO sinal (e não-zero) pra Track A considerar "consistente" — 2 de 3, não as 3 (uma janela pequena pode legitimamente ficar sem dado suficiente pra ter sinal definido). */
const MIN_CONSISTENT_WINDOWS = 2;
/**
 * Mínimo de eventos de CADA lado (feature presente/ausente) DENTRO de uma
 * janela pra o sinal dela contar no gate de consistência — achado de
 * review do #7980 (P2, média confiança): sem este piso, uma janela com
 * só 1 evento de cada lado "vota" com o MESMO peso de uma janela com
 * centenas, e 2 janelas finas concordando por acaso bastava pra passar
 * `passes_window_bar` — justo o tipo de ruído que o gate de janelas
 * existe pra filtrar (o módulo inteiro se propõe a ser MAIS rigoroso que
 * Track B). Valor pequeno o bastante pra não esvaziar o gate quando o
 * corpus total mal passa o piso de 40 edições/3 janelas (~13-14 edições
 * por janela) — não o mesmo `TRACK_A_EVENT_COUNT_MIN` (30), que é o piso
 * do corpus INTEIRO, não de 1/3 dele.
 */
const MIN_WINDOW_EVENTS_PER_SIDE = 8;
const PERMUTATIONS = 500;

/** 1 linha sintética por evento rotulado Track A (LLM escolheu, editor aprovou ou rejeitou) — paralela ao conceito de `EditionRows` de Track B, mas restrita a esta população. */
export interface TrackAEditionRows {
  edition: string;
  events: LabeledEvent[]; // só os com features !== null (ver loadTrackAEditionRows)
  approved: boolean[]; // paralelo a events — approved[i] = events[i].track_a === "llm_finalist_and_approved"
}

export interface TrackAPopulationResult {
  editions: TrackAEditionRows[];
  /** Contagem de eventos com `track_a` definido cujas features vieram `null` (sem scoring-features.json correspondente) — excluídos da população, nunca silenciosos. */
  events_missing_features: number;
  /** Diagnóstico: por feature candidata, quantos eventos `editor_promoted_outside_llm_finalists` a carregam — sinal de possível sub-ponderação do LLM, NUNCA usado no teste estatístico (ver docstring do módulo). */
  promoted_outside_by_feature: Record<TrackACandidateFeature, number>;
  promoted_outside_total: number;
}

/**
 * Filtra `analyzeAllEditions()` pra população Track A (só `track_a` em
 * {llm_finalist_and_approved, llm_finalist_rejected_by_editor}, com
 * features presentes), agrupada por edição — e calcula o diagnóstico de
 * `editor_promoted_outside_llm_finalists` à parte.
 */
export function buildTrackAPopulation(editionsRoot: string): TrackAPopulationResult {
  const all = analyzeAllEditions(editionsRoot);
  const byEdition = new Map<string, LabeledEvent[]>();
  let missingFeatures = 0;
  const promotedOutsideByFeature = Object.fromEntries(TRACK_A_CANDIDATE_FEATURES.map((f) => [f, 0])) as Record<TrackACandidateFeature, number>;
  let promotedOutsideTotal = 0;

  for (const event of all.events) {
    if (event.track_a === "editor_promoted_outside_llm_finalists") {
      promotedOutsideTotal++;
      if (event.features) {
        for (const f of TRACK_A_CANDIDATE_FEATURES) {
          if (trackAFeatureValue(event.features, f)) promotedOutsideByFeature[f]++;
        }
      }
      continue;
    }
    if (event.track_a !== "llm_finalist_and_approved" && event.track_a !== "llm_finalist_rejected_by_editor") continue;
    if (event.features === null) {
      missingFeatures++;
      continue;
    }
    const bucket = byEdition.get(event.edition) ?? [];
    bucket.push(event);
    byEdition.set(event.edition, bucket);
  }

  const editions: TrackAEditionRows[] = [...byEdition.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([edition, events]) => ({
      edition,
      events,
      approved: events.map((e) => e.track_a === "llm_finalist_and_approved"),
    }));

  return { editions, events_missing_features: missingFeatures, promoted_outside_by_feature: promotedOutsideByFeature, promoted_outside_total: promotedOutsideTotal };
}

interface TrackAFeatureReport {
  feature: TrackACandidateFeature;
  n_true: number;
  n_false: number;
  approved_rate_true: number;
  approved_rate_false: number;
  diff: number;
  evaluable_editions: number;
  passes_event_bar: boolean; // só os pisos numéricos (30/40), sem o gate de janelas
  null_p_value: number;
  window_diffs: Array<number | null>; // 1 por VALIDATION_WINDOWS, null = janela sem dado suficiente (1 lado vazio)
  consistent_windows: number; // quantas de window_diffs têm o MESMO sinal (não-nulo, não-zero) que a maioria
  passes_window_bar: boolean; // consistent_windows >= MIN_CONSISTENT_WINDOWS
  /** Gate FINAL do Track A — `passes_event_bar && passes_window_bar`. */
  passes_evidence_bar_track_a: boolean;
  promoted_outside_count: number; // diagnóstico, nunca usado nos gates acima
}

function featureValueForEvent(event: LabeledEvent, feature: TrackACandidateFeature): boolean {
  // events desta população sempre têm features !== null (filtrado em buildTrackAPopulation)
  return trackAFeatureValue(event.features!, feature);
}

function computeCounts(editions: TrackAEditionRows[], feature: TrackACandidateFeature): { nTrue: number; nFalse: number; approvedTrue: number; approvedFalse: number; diff: number | null } {
  let trueTotal = 0;
  let trueApproved = 0;
  let falseTotal = 0;
  let falseApproved = 0;
  for (const ed of editions) {
    for (let i = 0; i < ed.events.length; i++) {
      if (featureValueForEvent(ed.events[i], feature)) {
        trueTotal++;
        if (ed.approved[i]) trueApproved++;
      } else {
        falseTotal++;
        if (ed.approved[i]) falseApproved++;
      }
    }
  }
  const diff = trueTotal > 0 && falseTotal > 0 ? trueApproved / trueTotal - falseApproved / falseTotal : null;
  return { nTrue: trueTotal, nFalse: falseTotal, approvedTrue: trueApproved, approvedFalse: falseApproved, diff };
}

/** Divide `editions` (já ordenadas cronologicamente) em `VALIDATION_WINDOWS` fatias contíguas — a última fatia absorve o resto quando a divisão não é exata. */
function splitIntoWindows(editions: TrackAEditionRows[]): TrackAEditionRows[][] {
  const windows: TrackAEditionRows[][] = [];
  const size = Math.floor(editions.length / VALIDATION_WINDOWS);
  if (size === 0) return [editions]; // dado de menos pra sequer 1 janela cheia — 1 janela só, sinalizado abaixo pela contagem de janelas com dado
  for (let w = 0; w < VALIDATION_WINDOWS; w++) {
    const start = w * size;
    const end = w === VALIDATION_WINDOWS - 1 ? editions.length : start + size;
    windows.push(editions.slice(start, end));
  }
  return windows;
}

function analyzeTrackAFeature(editions: TrackAEditionRows[], feature: TrackACandidateFeature, seed: number, promotedOutsideCount: number): TrackAFeatureReport {
  const observed = computeCounts(editions, feature);
  const { nTrue, nFalse, approvedTrue, approvedFalse } = observed;
  const diff = observed.diff ?? 0;
  const approvedRateTrue = nTrue > 0 ? approvedTrue / nTrue : 0;
  const approvedRateFalse = nFalse > 0 ? approvedFalse / nFalse : 0;

  let evaluableEditions = 0;
  for (const ed of editions) {
    let hasTrue = false;
    let hasFalse = false;
    for (const event of ed.events) {
      if (featureValueForEvent(event, feature)) hasTrue = true;
      else hasFalse = true;
      if (hasTrue && hasFalse) break;
    }
    if (hasTrue && hasFalse) evaluableEditions++;
  }

  const passesEventBar = nTrue >= TRACK_A_EVENT_COUNT_MIN && nFalse >= TRACK_A_EVENT_COUNT_MIN && evaluableEditions >= TRACK_A_EVALUABLE_EDITIONS_MIN;

  // Baseline nulo por permutação — mesmo método de Track B (embaralha
  // `approved` DENTRO de cada edição, preserva quantos aprovados aquela
  // edição teve).
  const rand = mulberry32(seed);
  let nullExceedsOrEquals = 0;
  const absObserved = Math.abs(diff);
  for (let p = 0; p < PERMUTATIONS; p++) {
    let trueTotal = 0;
    let trueApproved = 0;
    let falseTotal = 0;
    let falseApproved = 0;
    for (const ed of editions) {
      const shuffled = [...ed.approved];
      shuffleInPlace(shuffled, rand);
      for (let i = 0; i < ed.events.length; i++) {
        if (featureValueForEvent(ed.events[i], feature)) {
          trueTotal++;
          if (shuffled[i]) trueApproved++;
        } else {
          falseTotal++;
          if (shuffled[i]) falseApproved++;
        }
      }
    }
    const nullDiff = trueTotal > 0 && falseTotal > 0 ? trueApproved / trueTotal - falseApproved / falseTotal : 0;
    if (Math.abs(nullDiff) >= absObserved) nullExceedsOrEquals++;
  }
  const nullPValue = nullExceedsOrEquals / PERMUTATIONS;

  // Gate de janelas (#7980, específico do Track A — Track B não tem isto
  // como gate duro, só reporta 1 corte early/late).
  const windows = splitIntoWindows(editions);
  // `diff` vira `null` (excluído do voto de sinal) quando qualquer um dos
  // 2 lados da janela tem menos que MIN_WINDOW_EVENTS_PER_SIDE eventos —
  // não só quando um lado está genuinamente vazio (mitigação P2, #7980).
  const windowDiffs = windows.map((w) => {
    const c = computeCounts(w, feature);
    if (c.nTrue < MIN_WINDOW_EVENTS_PER_SIDE || c.nFalse < MIN_WINDOW_EVENTS_PER_SIDE) return null;
    return c.diff;
  });
  const nonZeroSigned = windowDiffs.filter((d): d is number => d !== null && d !== 0).map((d) => Math.sign(d));
  let consistentWindows = 0;
  if (nonZeroSigned.length > 0) {
    const positive = nonZeroSigned.filter((s) => s > 0).length;
    const negative = nonZeroSigned.filter((s) => s < 0).length;
    consistentWindows = Math.max(positive, negative);
  }
  const passesWindowBar = consistentWindows >= MIN_CONSISTENT_WINDOWS;

  return {
    feature,
    n_true: nTrue,
    n_false: nFalse,
    approved_rate_true: approvedRateTrue,
    approved_rate_false: approvedRateFalse,
    diff,
    evaluable_editions: evaluableEditions,
    passes_event_bar: passesEventBar,
    null_p_value: nullPValue,
    window_diffs: windowDiffs,
    consistent_windows: consistentWindows,
    passes_window_bar: passesWindowBar,
    passes_evidence_bar_track_a: passesEventBar && passesWindowBar,
    promoted_outside_count: promotedOutsideCount,
  };
}

export interface TrackAPowerReportResult {
  editions_analyzed: number;
  events_missing_features: number;
  promoted_outside_total: number;
  features: TrackAFeatureReport[];
}

/**
 * `precomputedPopulation` (opcional, achado de review do #7980, P3 —
 * eficiência): quem já tem a população em mãos (ex: `calibrate-track-a-
 * weights.ts`, que precisa dela de novo pra montar o design matrix)
 * evita re-ler/re-parsear `01-categorized.json`/`01-approved.json`/
 * `scoring-features.json` de TODA edição uma 2ª vez. Sem o parâmetro, o
 * comportamento é idêntico ao de antes (constrói a população do zero).
 */
export function buildTrackAPowerReport(editionsRoot: string, seed = 42, precomputedPopulation?: TrackAPopulationResult): TrackAPowerReportResult {
  const population = precomputedPopulation ?? buildTrackAPopulation(editionsRoot);
  const features = TRACK_A_CANDIDATE_FEATURES.map((f, i) => analyzeTrackAFeature(population.editions, f, seed + i, population.promoted_outside_by_feature[f]));
  return {
    editions_analyzed: population.editions.length,
    events_missing_features: population.events_missing_features,
    promoted_outside_total: population.promoted_outside_total,
    features,
  };
}

function formatReport(report: TrackAPowerReportResult): string {
  const lines: string[] = [];
  lines.push(`[calibration-power-report-track-a] ${report.editions_analyzed} edições com evento(s) Track A (LLM escolheu como 1 dos 6, editor aprovou ou rejeitou).`);
  if (report.events_missing_features > 0) {
    lines.push(`  ${report.events_missing_features} evento(s) Track A SEM scoring-features.json correspondente — excluídos da população.`);
  }
  lines.push(`  ${report.promoted_outside_total} evento(s) editor_promoted_outside_llm_finalists (diagnóstico, fora do teste estatístico).`);
  lines.push("");
  for (const f of report.features) {
    const bar = f.passes_evidence_bar_track_a ? "PASSA a barra de evidência do Track A" : "abaixo da barra de evidência do Track A";
    lines.push(`${f.feature}: ${bar}`);
    lines.push(
      `  n_true=${f.n_true} (aprovado ${(f.approved_rate_true * 100).toFixed(1)}%)  n_false=${f.n_false} (aprovado ${(f.approved_rate_false * 100).toFixed(1)}%)  diff=${(f.diff * 100).toFixed(1)}pp  edições_avaliáveis=${f.evaluable_editions} (piso evento/edição: ${f.passes_event_bar ? "OK" : "FALHA"})`,
    );
    lines.push(
      `  baseline nulo: p=${f.null_p_value.toFixed(3)}  janelas consistentes=${f.consistent_windows}/${VALIDATION_WINDOWS} (piso ${MIN_CONSISTENT_WINDOWS}: ${f.passes_window_bar ? "OK" : "FALHA"})  diffs por janela=[${f.window_diffs.map((d) => (d === null ? "n/d" : `${(d * 100).toFixed(1)}pp`)).join(", ")}]`,
    );
    lines.push(`  diagnóstico: ${f.promoted_outside_count} evento(s) editor_promoted_outside_llm_finalists carregam esta feature (não conta pro gate acima).`);
    lines.push("");
  }
  return lines.join("\n");
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const editionsRoot = resolve(ROOT, values["editions-dir"] ?? "data/editions");
  const json = process.argv.includes("--json");
  const report = buildTrackAPowerReport(editionsRoot);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
}
