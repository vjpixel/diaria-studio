#!/usr/bin/env npx tsx
/**
 * scripts/trigger-track-b-calibration.ts (#7979, Camada 5 da #7972 — Fase 5)
 *
 * Esteira overnight/develop chama isto (ainda não wireada em nenhuma
 * skill — ver PENDÊNCIA no rodapé) pra decidir, sem intervenção manual,
 * se algum candidato de Track B já tem evidência suficiente e cadência
 * livre pra abrir um PR de calibração de verdade.
 *
 * Pipeline: `calibration-power-report.ts` (quais features passam a
 * barra) → filtra as que já têm PR de calibração aberta/mergeada
 * (`data/reports/index.jsonl`, kind "calibration") → rankeia as
 * restantes por valor (`calibration-cadence-guard.ts::rankQueuedCandidates`)
 * → aplica os 3 guardrails de cadência → decide.
 *
 * **PENDÊNCIA NOMEADA, bloqueio real de dependência (não frouxidão de
 * escopo):** mesmo quando um candidato é elegível E a cadência permite,
 * este script NÃO abre um PR de calibração de verdade — porque o
 * mecanismo que computa QUAL delta de peso propor
 * (`calibrate-scoring-weights.ts`, regressão de verdade) foi deferido da
 * Fase 2 pra issue #7990 e ainda não existe. Sem ele, não há um número
 * concreto pra colocar no candidato de peso — abrir um PR "de
 * calibração" sem um valor calibrado seria teatro, não o mecanismo real.
 * O que este script FAZ hoje: toda a decisão de ELEGIBILIDADE +
 * CADÊNCIA (o que #7979 pede) e reporta claramente "candidato pronto,
 * aguardando #7990" em vez de fabricar uma PR vazia. Quando #7990
 * existir, o único ponto que falta é: chamar
 * `calibrate-scoring-weights.ts` pra computar o delta, montar o
 * `CalibrationEvidenceInput` (`generate-calibration-evidence-report.ts`),
 * e abrir a PR draft com `needs-editor-signoff`.
 *
 * Uso:
 *   npx tsx scripts/trigger-track-b-calibration.ts [--editions-dir DIR] [--now ISO] [--json]
 */
import { resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { buildPowerReport, CANDIDATE_FEATURES } from "./calibration-power-report.ts";
import { evaluateCadence, rankQueuedCandidates, type CadenceState, type QueuedCandidate, type RankedCandidate } from "./lib/calibration-cadence-guard.ts";
import { listReports } from "./studio-ui/studio-reports.ts";

const ROOT = resolve(import.meta.dirname, "..");

/** Extrai o nome da feature do título "Calibração {feature} — PR #{n}" gravado por generate-calibration-evidence-report.ts. `null` se o título não bater no formato esperado (defensivo — nunca trava o trigger por causa de um título legado/manual). */
export function featureFromCalibrationReportTitle(title: string): string | null {
  const m = /^Calibração\s+(\S+)\s+—\s+PR/.exec(title);
  return m ? m[1] : null;
}

export interface TrackBTriggerResult {
  eligible: RankedCandidate[];
  alreadyCovered: string[];
  cadence: ReturnType<typeof evaluateCadence>;
  /** Feature escolhida pra disparar AGORA — só preenchido se elegível + cadência livre. `null` caso contrário (fila vazia, ou tudo bloqueado por cadência). */
  chosenFeature: string | null;
  /** `true` sse `chosenFeature !== null` — achado de review do #7979: uma constante estática aqui esconderia "fila vazia/cadência bloqueando" atrás de "sempre bloqueado por #7990", confundindo um futuro consumidor do `--json`. Ver PENDÊNCIA no cabeçalho do arquivo (#7990 não existe ainda). */
  blockedOnWeightComputation: boolean;
}

export function decideTrackBTrigger(editionsRoot: string, rootDir: string, nowIso: string): TrackBTriggerResult {
  const report = buildPowerReport(editionsRoot);
  const passing = report.features.filter((f) => f.passes_event_bar);

  const calibrationReports = listReports(rootDir).filter((r) => r.kind === "calibration");
  const alreadyCovered = new Set(calibrationReports.map((r) => featureFromCalibrationReportTitle(r.title)).filter((f): f is string => f !== null));

  const candidates: QueuedCandidate[] = passing
    .filter((f) => !alreadyCovered.has(f.feature))
    .map((f) => ({ feature: f.feature, effectSize: Math.abs(f.diff), confidence: 1 - f.null_p_value }));

  const ranked = rankQueuedCandidates(candidates);

  const candidateOpenedAt = calibrationReports.map((r) => r.createdAt);
  const state: CadenceState = {
    candidateOpenedAt,
    // Simplificação MVP (documentada): 1 digest por candidato aberto — não
    // há hoje um mecanismo de digest AGREGADO separado (#7979 pede "1
    // sessão combinada por semana, agregando todos os candidatos prontos"
    // — implementável quando houver mais de 1 candidato elegível
    // simultâneo pra agregar de verdade; até lá, 1 candidato = 1 digest).
    digestSentAt: candidateOpenedAt,
    liveCalibratableParamCount: CANDIDATE_FEATURES.length,
  };
  const cadence = evaluateCadence(state, nowIso);

  const chosenFeature = cadence.canOpenNewCandidate && cadence.canSendSignoffDigest && !cadence.atParamBudgetCap && ranked.length > 0 ? ranked[0].feature : null;

  return { eligible: ranked, alreadyCovered: [...alreadyCovered], cadence, chosenFeature, blockedOnWeightComputation: chosenFeature !== null };
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const editionsRoot = resolve(ROOT, values["editions-dir"] ?? "data/editions");
  const nowIso = values["now"] ?? new Date().toISOString();
  const json = process.argv.includes("--json");

  const result = decideTrackBTrigger(editionsRoot, ROOT, nowIso);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[trigger-track-b-calibration] ${result.eligible.length} candidato(s) elegível(is), ${result.alreadyCovered.length} já coberto(s) por PR anterior.`);
    for (const c of result.eligible) console.log(`  ${c.feature}: value=${c.value.toFixed(3)} (effectSize=${c.effectSize.toFixed(3)}, confidence=${c.confidence.toFixed(3)})`);
    if (result.cadence.reasons.length > 0) {
      console.log("  Cadência bloqueando:");
      for (const r of result.cadence.reasons) console.log(`    - ${r}`);
    }
    if (result.chosenFeature) {
      console.log(`  → candidato escolhido pra disparar: ${result.chosenFeature}`);
      console.log(`  → BLOQUEADO em calibrate-scoring-weights.ts (#7990, ainda não existe) — nenhum PR aberto. Ver docstring do script.`);
    } else {
      console.log("  → nenhum candidato disparado nesta rodada (fila vazia ou cadência bloqueando).");
    }
  }
}
