#!/usr/bin/env npx tsx
/**
 * scripts/trigger-track-a-calibration.ts (#7980, Fase 6 da #7972)
 *
 * Análogo de `trigger-track-b-calibration.ts` (#7979) pro Track A — decide,
 * sem intervenção manual, se algum bônus determinístico de seleção de
 * destaque (`scripts/lib/track-a-features.ts`) já tem evidência suficiente
 * (barra MAIS ALTA que Track B) E cadência livre E canário de
 * `negative_impact` limpo pra abrir um PR de calibração de verdade.
 *
 * Pipeline: `calibration-power-report-track-a.ts` (quais features passam
 * a barra do Track A) → `check-track-a-negative-impact-canary.ts`
 * (canário obrigatório, #7972 mitigação I-1 — QUALQUER recomendação de
 * pausa, OU histórico ainda insuficiente pra avaliar, BLOQUEIA a rodada
 * inteira, mesmo que alguma feature esteja elegível) → filtra features
 * já cobertas por PR de calibração aberta/mergeada (`data/reports/
 * index.jsonl`, kind "calibration" — MESMO registro que Track B usa,
 * sem campo de track próprio). **`TRACK_A_REPORT_FEATURE_PREFIX`
 * ("track-a:") é o que evita a colisão entre os dois tracks** — achado
 * de review do #7980 (P1, alta confiança): Track A e Track B
 * compartilham 5 de 6 nomes de feature (`primary_source`/`hands_on`/
 * `academy`/`howto_br`/`howto_br_source`); sem um jeito de distinguir de
 * qual track um relatório "Calibração {feature} — PR #N" veio, uma PR de
 * Track B mergeada pra `primary_source` bloquearia `primary_source` do
 * Track A PARA SEMPRE (e vice-versa), silenciosamente, contradizendo a
 * separação de escopo/diretório/barra de evidência que o resto deste
 * módulo garante. `featureFromCalibrationReportTitle` (abaixo) só conta
 * um relatório como cobrindo Track A se o nome de feature no título
 * carregar o prefixo — nunca um nome puro (esse é ambíguo, pode ser de
 * Track B). **Pendência de fiação, documentada explicitamente**: nenhum
 * script deste repo hoje CHAMA `generate-calibration-evidence-report.ts`
 * pra Track A (nem pra Track B — mesma pendência que `trigger-track-b-
 * calibration.ts` já documenta, abrir a PR de verdade é ação de fora
 * destes scripts) — quando essa fiação existir, o `feature` passado ao
 * `CalibrationEvidenceInput` PARA O TRACK A precisa ser
 * `trackAReportFeatureLabel(candidato)` (`scripts/lib/track-a-features.ts`),
 * nunca o nome puro, senão o título gerado não carrega o prefixo e o
 * relatório nunca é reconhecido como "já coberto" por este trigger. →
 * `calibration-cadence-guard.ts::rankQueuedCandidates`/`evaluateCadence`
 * (mesmos 3 tetos de Track B — `MAX_LIVE_CALIBRATABLE_PARAMS` é um teto
 * ÚNICO, pensado pro custo de revisão do editor total, independente de
 * qual track o parâmetro vem; a contagem de "parâmetros vivos" usada aqui
 * é uma simplificação por track, mesma de Track B — ver comentário
 * inline em `decideTrackATrigger`) → se elegível + cadência livre +
 * canário limpo, chama
 * `calibrate-track-a-weights.ts` de verdade (diferente de Track B em
 * 11/09/2026: aqui a Fase de regressão de verdade JÁ EXISTE nesta mesma
 * PR, então o trigger do Track A não tem a mesma pendência nomeada que
 * `trigger-track-b-calibration.ts` documentou pra #7990) — mas só chega
 * a produzir pesos quando o corpus real (40+ edições-calendário Track A)
 * de fato existir; num corpus vazio/pequeno (ex: este worktree, sem
 * `data/editions/` real) o resultado é `no_eligible_features`/
 * `insufficient_training_data`, honestamente, nunca um candidato
 * fabricado.
 *
 * Uso:
 *   npx tsx scripts/trigger-track-a-calibration.ts [--editions-dir DIR] [--now ISO] [--json]
 */
import { resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { buildTrackAPowerReport } from "./calibration-power-report-track-a.ts";
import { TRACK_A_CANDIDATE_FEATURES, TRACK_A_REPORT_FEATURE_PREFIX } from "./lib/track-a-features.ts";
import { computeCanarySeries } from "./check-track-a-negative-impact-canary.ts";
import { analyzeCanaryTrend, type CanaryTrendResult } from "./lib/track-a-negative-impact-canary.ts";
import { evaluateCadence, rankQueuedCandidates, type CadenceState, type QueuedCandidate, type RankedCandidate } from "./lib/calibration-cadence-guard.ts";
import { calibrateTrackAWeights, type CalibrateTrackAResult } from "./calibrate-track-a-weights.ts";
import { listReports } from "./studio-ui/studio-reports.ts";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Mesmo formato de título de `trigger-track-b-calibration.ts::featureFromCalibrationReportTitle`
 * ("Calibração {feature} — PR #{n}") — MAS, diferente de Track B, só
 * retorna a feature quando o nome carrega `TRACK_A_REPORT_FEATURE_PREFIX`
 * ("track-a:") — nunca um nome puro, que é ambíguo entre os 2 tracks (ver
 * docstring do módulo e de `TRACK_A_REPORT_FEATURE_PREFIX` em
 * `track-a-features.ts`, achado de review do #7980, P1). Um relatório de
 * Track B pra `primary_source` (sem prefixo) retorna `null` aqui — nunca
 * conta como "Track A já coberto".
 */
export function featureFromCalibrationReportTitle(title: string): string | null {
  const m = /^Calibração\s+(\S+)\s+—\s+PR/.exec(title);
  if (!m) return null;
  const raw = m[1];
  if (!raw.startsWith(TRACK_A_REPORT_FEATURE_PREFIX)) return null;
  return raw.slice(TRACK_A_REPORT_FEATURE_PREFIX.length);
}

export interface TrackATriggerResult {
  eligible: RankedCandidate[];
  alreadyCovered: string[];
  canary: CanaryTrendResult;
  cadence: ReturnType<typeof evaluateCadence>;
  chosenFeature: string | null;
  /** Preenchido só quando `chosenFeature !== null` — resultado de `calibrateTrackAWeights` pra aquele candidato específico (pode ainda ser `no_eligible_features`/`insufficient_training_data` no corpus real de hoje; ver docstring do módulo). */
  calibration: CalibrateTrackAResult | null;
}

export function decideTrackATrigger(editionsRoot: string, rootDir: string, nowIso: string): TrackATriggerResult {
  const powerReport = buildTrackAPowerReport(editionsRoot);
  const passing = powerReport.features.filter((f) => f.passes_evidence_bar_track_a);

  const canaryPoints = computeCanarySeries(editionsRoot);
  const canary = analyzeCanaryTrend(canaryPoints);

  const calibrationReports = listReports(rootDir).filter((r) => r.kind === "calibration");
  const alreadyCovered = new Set(calibrationReports.map((r) => featureFromCalibrationReportTitle(r.title)).filter((f): f is string => f !== null));

  const candidates: QueuedCandidate[] = passing
    .filter((f) => !alreadyCovered.has(f.feature))
    .map((f) => ({ feature: f.feature, effectSize: Math.abs(f.diff), confidence: 1 - f.null_p_value }));

  const ranked = rankQueuedCandidates(candidates);

  const candidateOpenedAt = calibrationReports.map((r) => r.createdAt);
  const state: CadenceState = {
    candidateOpenedAt,
    digestSentAt: candidateOpenedAt, // mesma simplificação MVP de Track B — ver trigger-track-b-calibration.ts
    // Mesma simplificação de Track B (`trigger-track-b-calibration.ts`):
    // usa o TAMANHO DO UNIVERSO de features candidatas do próprio track
    // como proxy de "parâmetros vivos", não uma contagem real de quantos
    // já foram promovidos (nenhum mecanismo hoje soma os dois tracks num
    // orçamento único — refinamento futuro se o orçamento compartilhado
    // vier a apertar de verdade).
    liveCalibratableParamCount: TRACK_A_CANDIDATE_FEATURES.length,
  };
  const cadence = evaluateCadence(state, nowIso);

  // Canário BLOQUEIA a rodada inteira, mesmo com cadência livre e feature
  // elegível — é o gate de segurança do Track A (#7972 mitigação I-1),
  // checado ANTES de considerar qualquer candidato. `canary.assessable`
  // (não só `!canary.pause_recommended`) faz parte do gate — achado de
  // review do #7980 (P1, alta confiança): histórico ainda insuficiente
  // pra ter baseline (`assessable: false`) também produz
  // `pause_recommended: false`, e sem checar `assessable` aqui a 1ª
  // rodada de um corpus jovem leria o canário como "limpo" por ausência
  // de dado, nunca o que um canário OBRIGATÓRIO deveria fazer.
  const canaryClear = canary.assessable && !canary.pause_recommended;
  const chosenFeature = canaryClear && cadence.canOpenNewCandidate && cadence.canSendSignoffDigest && !cadence.atParamBudgetCap && ranked.length > 0 ? ranked[0].feature : null;

  const calibration = chosenFeature ? calibrateTrackAWeights(editionsRoot, rootDir) : null;

  return { eligible: ranked, alreadyCovered: [...alreadyCovered], canary, cadence, chosenFeature, calibration };
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const editionsRoot = resolve(ROOT, values["editions-dir"] ?? "data/editions");
  const nowIso = values["now"] ?? new Date().toISOString();
  const json = process.argv.includes("--json");

  const result = decideTrackATrigger(editionsRoot, ROOT, nowIso);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[trigger-track-a-calibration] ${result.eligible.length} candidato(s) elegível(is), ${result.alreadyCovered.length} já coberto(s) por PR anterior.`);
    for (const c of result.eligible) console.log(`  ${c.feature}: value=${c.value.toFixed(3)} (effectSize=${c.effectSize.toFixed(3)}, confidence=${c.confidence.toFixed(3)})`);
    console.log(`  canário negative_impact: avaliável=${result.canary.assessable ? "sim" : "não"}  pausar=${result.canary.pause_recommended ? "SIM" : "não"}${result.canary.reasons.length > 0 ? " — " + result.canary.reasons.join("; ") : ""}`);
    if (result.cadence.reasons.length > 0) {
      console.log("  Cadência bloqueando:");
      for (const r of result.cadence.reasons) console.log(`    - ${r}`);
    }
    if (result.chosenFeature) {
      console.log(`  → candidato escolhido pra disparar: ${result.chosenFeature}`);
      console.log(`  → calibrate-track-a-weights.ts: status=${result.calibration?.status}`);
    } else {
      console.log("  → nenhum candidato disparado nesta rodada (fila vazia, cadência bloqueando, ou canário recomendando pausa).");
    }
  }
}
