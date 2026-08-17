/**
 * control-edition-compare.ts (#5547 item 2)
 *
 * Comparador antes/depois do instrumento de medição da edição de controle
 * (#5419). Recebe duas medições (`ControlEditionMeasurement` + `contamination`,
 * produzidas por `scripts/measure-control-edition.ts`) — baseline e
 * tratamento — e emite a comparação lado a lado por stage + total, com o
 * veredito já embutido: qual dos 2 casos previstos pela #5419 ocorreu.
 *
 * Critério de decisão, tal como registrado na #5419 (não repetido de
 * memória — citado aqui para não divergir do texto da issue):
 *
 *   > hipótese de ~-49% de redução (708M→360M tokens na simulação sobre a
 *   > edição 260814); resultado abaixo de -30% invalida a simulação e exige
 *   > revisar a base de 130k tokens/stage assumida.
 *
 * "Tokens totais" aqui = `tokens_in + tokens_out` por stage/edição — a saída
 * do modelo é ~0,2% do total por stage segundo a mesma auditoria (#5414), então
 * a escolha entre "só tokens_in" e "tokens_in + tokens_out" não move o
 * resultado de forma material; usar a soma é a leitura mais literal de
 * "tokens" no corpo da #5419/#5414.
 *
 * O veredito (`hypothesis_confirmed` | `hypothesis_invalidated`) é sempre
 * IMPRESSO explicitamente (nunca só os números crus) — ver
 * `formatComparisonReport`. Quando qualquer uma das duas medições está
 * marcada `contamination.contaminated`, o veredito ainda é calculado (os
 * números não são descartados em silêncio) mas sai prefixado com um aviso
 * de confiabilidade — nunca aceito como bom sem esse aviso (#5547 item 3).
 */

import type { ControlEditionMeasurementWithContamination as MeasureResult } from "./control-edition-metrics.ts";

/** Piso de corte que valida a hipótese da #5419 — abaixo disso (em módulo),
 * a simulação de 130k tokens/stage precisa ser revisada. */
export const HYPOTHESIS_FLOOR_PCT = -30;
/** Hipótese registrada na #5419/#5414 (708M → 360M na simulação, 260814). */
export const HYPOTHESIS_EXPECTED_PCT = -49;

export interface StageComparison {
  stage: number;
  label: string;
  baseline_tokens_in: number | null;
  treatment_tokens_in: number | null;
  baseline_tokens_out: number | null;
  treatment_tokens_out: number | null;
  baseline_turns: number | null;
  treatment_turns: number | null;
  baseline_avg_context_per_turn: number | null;
  treatment_avg_context_per_turn: number | null;
  baseline_subagent_tokens_in: number | null;
  treatment_subagent_tokens_in: number | null;
  /** Variação % de `tokens_in + tokens_out`. `null` quando algum dos dois
   * totais do stage não é derivável (baseline ou tratamento ausente/`null`). */
  total_tokens_pct_change: number | null;
}

export interface ComparisonResult {
  baseline_edition: string;
  treatment_edition: string;
  generated_at: string;
  stages: StageComparison[];
  totals: {
    baseline_tokens: number | null;
    treatment_tokens: number | null;
    pct_change: number | null;
  };
  /** Qual dos 2 casos da #5419 ocorreu — `null` só quando `pct_change` total
   * não é computável (dado insuficiente nas duas medições). */
  verdict: "hypothesis_confirmed" | "hypothesis_invalidated" | null;
  /** `true` quando QUALQUER uma das duas medições está marcada como
   * contaminada pelo guard (#5547 item 3) — o veredito acima continua
   * calculado, mas não deve ser lido como confiável sem revisar os dois
   * `contamination` originais. */
  reliability_warning: boolean;
  contamination: {
    baseline: MeasureResult["contamination"];
    treatment: MeasureResult["contamination"];
  };
}

function totalTokens(m: MeasureResult): number | null {
  const { tokens_in, tokens_out } = m.totals;
  if (tokens_in == null || tokens_out == null) return null;
  return tokens_in + tokens_out;
}

function pctChange(before: number | null, after: number | null): number | null {
  if (before == null || after == null || before === 0) return null;
  return ((after - before) / before) * 100;
}

function stageTotal(tokensIn: number | null, tokensOut: number | null): number | null {
  if (tokensIn == null || tokensOut == null) return null;
  return tokensIn + tokensOut;
}

export function compareControlEditions(
  baseline: MeasureResult,
  treatment: MeasureResult,
  generatedAt: string = new Date().toISOString(),
): ComparisonResult {
  const byStage = new Map<number, { baseline?: MeasureResult["stages"][number]; treatment?: MeasureResult["stages"][number] }>();
  for (const s of baseline.stages) byStage.set(s.stage, { baseline: s });
  for (const s of treatment.stages) {
    const existing = byStage.get(s.stage) ?? {};
    byStage.set(s.stage, { ...existing, treatment: s });
  }

  const stages: StageComparison[] = [...byStage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([stage, { baseline: b, treatment: t }]) => {
      const label = b?.label ?? t?.label ?? `Stage ${stage}`;
      const bTotal = stageTotal(b?.tokens_in ?? null, b?.tokens_out ?? null);
      const tTotal = stageTotal(t?.tokens_in ?? null, t?.tokens_out ?? null);
      return {
        stage,
        label,
        baseline_tokens_in: b?.tokens_in ?? null,
        treatment_tokens_in: t?.tokens_in ?? null,
        baseline_tokens_out: b?.tokens_out ?? null,
        treatment_tokens_out: t?.tokens_out ?? null,
        baseline_turns: b?.turns ?? null,
        treatment_turns: t?.turns ?? null,
        baseline_avg_context_per_turn: b?.avg_context_per_turn ?? null,
        treatment_avg_context_per_turn: t?.avg_context_per_turn ?? null,
        baseline_subagent_tokens_in: b?.subagent_tokens_in ?? null,
        treatment_subagent_tokens_in: t?.subagent_tokens_in ?? null,
        total_tokens_pct_change: pctChange(bTotal, tTotal),
      };
    });

  const baselineTotal = totalTokens(baseline);
  const treatmentTotal = totalTokens(treatment);
  const totalPct = pctChange(baselineTotal, treatmentTotal);

  const verdict: ComparisonResult["verdict"] =
    totalPct == null ? null : totalPct <= HYPOTHESIS_FLOOR_PCT ? "hypothesis_confirmed" : "hypothesis_invalidated";

  return {
    baseline_edition: baseline.edition,
    treatment_edition: treatment.edition,
    generated_at: generatedAt,
    stages,
    totals: {
      baseline_tokens: baselineTotal,
      treatment_tokens: treatmentTotal,
      pct_change: totalPct,
    },
    verdict,
    reliability_warning: baseline.contamination.contaminated || treatment.contamination.contaminated,
    contamination: { baseline: baseline.contamination, treatment: treatment.contamination },
  };
}

function fmtNum(n: number | null): string {
  if (n == null) return "null";
  return n.toLocaleString("pt-BR");
}

function fmtPct(n: number | null): string {
  if (n == null) return "-";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

/** Renderiza o relatório humano-legível (tabela + veredito explícito). Usado
 * pelo CLI; separado para ser testável sem capturar stdout. */
export function formatComparisonReport(result: ComparisonResult): string {
  const lines: string[] = [];
  lines.push(`# Comparação de edição de controle (#5419)`);
  lines.push("");
  lines.push(`Baseline: ${result.baseline_edition}  |  Tratamento: ${result.treatment_edition}`);
  lines.push("");

  if (result.reliability_warning) {
    lines.push("⚠️  AVISO DE CONFIABILIDADE — uma ou ambas as medições estão marcadas CONTAMINADAS pelo guard de");
    lines.push("    ruído concorrente (#5547 item 3). O veredito abaixo é calculado normalmente, mas NÃO deve ser");
    lines.push("    lido como conclusivo sem revisar os motivos abaixo.");
    if (result.contamination.baseline.contaminated) {
      lines.push(`    - baseline (${result.baseline_edition}) CONTAMINADA: ${result.contamination.baseline.reasons.join(" | ")}`);
    }
    if (result.contamination.treatment.contaminated) {
      lines.push(`    - tratamento (${result.treatment_edition}) CONTAMINADA: ${result.contamination.treatment.reasons.join(" | ")}`);
    }
    lines.push("");
  }

  lines.push("| Stage | Tokens in (baseline) | Tokens in (tratamento) | Turnos (baseline) | Turnos (tratamento) | Contexto médio/turno (baseline) | Contexto médio/turno (tratamento) | Δ tokens totais |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const s of result.stages) {
    lines.push(
      `| ${s.stage} — ${s.label} | ${fmtNum(s.baseline_tokens_in)} | ${fmtNum(s.treatment_tokens_in)} | ` +
        `${fmtNum(s.baseline_turns)} | ${fmtNum(s.treatment_turns)} | ` +
        `${fmtNum(s.baseline_avg_context_per_turn)} | ${fmtNum(s.treatment_avg_context_per_turn)} | ` +
        `${fmtPct(s.total_tokens_pct_change)} |`,
    );
  }
  lines.push("");
  lines.push(
    `**Total (tokens_in + tokens_out)**: ${fmtNum(result.totals.baseline_tokens)} → ${fmtNum(result.totals.treatment_tokens)} (${fmtPct(result.totals.pct_change)})`,
  );
  lines.push("");

  if (result.verdict === null) {
    lines.push(
      `**Veredito: INDETERMINADO** — não há tokens totais suficientes em uma das duas medições para computar a variação. ` +
        `Ver \`totals\` de cada medição para o motivo (provavelmente stages não capturados).`,
    );
  } else if (result.verdict === "hypothesis_confirmed") {
    lines.push(
      `**Veredito: HIPÓTESE CONFIRMADA** — corte de ${fmtPct(result.totals.pct_change)} ficou dentro (ou além) do piso de ` +
        `${HYPOTHESIS_FLOOR_PCT}% que valida a simulação da #5419/#5414 (hipótese registrada: ~${HYPOTHESIS_EXPECTED_PCT}%, ` +
        `708M→360M tokens simulados sobre a edição 260814).`,
    );
  } else {
    lines.push(
      `**Veredito: HIPÓTESE INVALIDADA** — corte de ${fmtPct(result.totals.pct_change)} ficou ABAIXO do piso de ` +
        `${HYPOTHESIS_FLOOR_PCT}% (hipótese registrada na #5419/#5414 era ~${HYPOTHESIS_EXPECTED_PCT}%). ` +
        `Isto obriga a revisar a base de 130k tokens/stage assumida na simulação do #5414 antes de aceitar o resultado — ` +
        `não tratar o corte medido como o número final sem essa revisão.`,
    );
  }

  return lines.join("\n");
}
