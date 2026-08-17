/**
 * test/control-edition-compare.test.ts (#5547 item 2)
 *
 * Cobre `scripts/lib/control-edition-compare.ts` — o comparador antes/depois.
 * Regressões principais: (a) o veredito é sempre um dos 2 casos explícitos
 * da #5419 (nunca "silêncio de números crus"); (b) o piso de -30% e a
 * hipótese de -49% são os valores literais registrados na #5419 (não
 * reinventados); (c) contaminação NUNCA é descartada em silêncio nem some
 * do relatório formatado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compareControlEditions,
  formatComparisonReport,
  HYPOTHESIS_FLOOR_PCT,
  HYPOTHESIS_EXPECTED_PCT,
} from "../scripts/lib/control-edition-compare.ts";
import type { ControlEditionMeasurementWithContamination } from "../scripts/lib/control-edition-metrics.ts";

function cleanContamination() {
  return {
    contaminated: false,
    transcript_check: {
      total_sessions_excluded: 0,
      stages_with_excluded_sessions: [],
      stages_with_unfiltered_fallback: [],
      stages_without_capture: [],
      clean: true,
    },
    registry_check: { checked_at: "2026-08-17T00:00:00.000Z", other_active_sessions: [], clean: true },
    reasons: [],
  };
}

function measurement(
  edition: string,
  stageTotals: Array<{ stage: number; tokensIn: number; tokensOut: number; turns: number }>,
  contamination = cleanContamination(),
): ControlEditionMeasurementWithContamination {
  const stages = stageTotals.map((s) => ({
    stage: s.stage,
    label: `Stage ${s.stage}`,
    status: "done",
    tokens_in: s.tokensIn,
    tokens_out: s.tokensOut,
    turns: s.turns,
    turns_source: "session_transcript_rederived" as const,
    turns_session_filter: "current_session" as const,
    turns_sessions_excluded: 0,
    turns_tokens_in: s.tokensIn,
    token_count_mismatch: false,
    avg_context_per_turn: Math.round(s.tokensIn / s.turns),
    subagent_tokens_in: null,
    subagent_tokens_out: null,
    token_session_filter: "current_session" as const,
    token_sessions_excluded: 0,
    parse_errors: 0,
  }));
  const totals = {
    tokens_in: stages.reduce((a, s) => a + (s.tokens_in ?? 0), 0),
    tokens_out: stages.reduce((a, s) => a + (s.tokens_out ?? 0), 0),
    turns: stages.reduce((a, s) => a + (s.turns ?? 0), 0),
    avg_context_per_turn: null,
    subagent_tokens_in: null,
    subagent_tokens_out: null,
  };
  return {
    edition,
    generated_at: "2026-08-17T00:00:00.000Z",
    session_id_used: "session-abc",
    transcripts_dir: "/tmp/x",
    transcripts_dir_exists: true,
    stages,
    totals,
    contamination,
  };
}

describe("compareControlEditions — veredito explícito (#5419)", () => {
  it("hypothesis_confirmed quando o corte é >= 30% (em módulo) — ex: -49%, a hipótese registrada na #5419", () => {
    // baseline 1.000.000, tratamento 510.000 → -49%
    const baseline = measurement("260814", [{ stage: 4, tokensIn: 900_000, tokensOut: 100_000, turns: 500 }]);
    const treatment = measurement("260815", [{ stage: 4, tokensIn: 459_000, tokensOut: 51_000, turns: 250 }]);
    const result = compareControlEditions(baseline, treatment);
    assert.equal(result.verdict, "hypothesis_confirmed");
    assert.ok(result.totals.pct_change! <= HYPOTHESIS_FLOOR_PCT);
  });

  it("hypothesis_invalidated quando o corte fica ABAIXO do piso de -30% — ex: só -10%", () => {
    const baseline = measurement("260814", [{ stage: 4, tokensIn: 900_000, tokensOut: 100_000, turns: 500 }]);
    const treatment = measurement("260815", [{ stage: 4, tokensIn: 810_000, tokensOut: 90_000, turns: 480 }]);
    const result = compareControlEditions(baseline, treatment);
    assert.equal(result.verdict, "hypothesis_invalidated");
    assert.ok(result.totals.pct_change! > HYPOTHESIS_FLOOR_PCT);
  });

  it("piso e hipótese batem com os números LITERAIS registrados na #5419 (-30% piso, ~-49% hipótese)", () => {
    assert.equal(HYPOTHESIS_FLOOR_PCT, -30);
    assert.equal(HYPOTHESIS_EXPECTED_PCT, -49);
  });

  it("verdict null quando os totais não são computáveis (medição sem dado)", () => {
    const baseline = measurement("260814", []);
    const treatment = measurement("260815", []);
    const result = compareControlEditions(baseline, treatment);
    assert.equal(result.verdict, null);
  });

  it("reliability_warning=true quando QUALQUER uma das duas medições está contaminada", () => {
    const contaminated = { ...cleanContamination(), contaminated: true, reasons: ["ruído de sessão concorrente"] };
    const baseline = measurement(
      "260814",
      [{ stage: 4, tokensIn: 900_000, tokensOut: 100_000, turns: 500 }],
      contaminated,
    );
    const treatment = measurement("260815", [{ stage: 4, tokensIn: 459_000, tokensOut: 51_000, turns: 250 }]);
    const result = compareControlEditions(baseline, treatment);
    assert.equal(result.reliability_warning, true);
    // o veredito continua calculado — contaminação não apaga o número, só avisa.
    assert.equal(result.verdict, "hypothesis_confirmed");
  });

  it("compara stages presentes em só UMA das duas medições sem quebrar (stage ausente vira null)", () => {
    const baseline = measurement("260814", [
      { stage: 4, tokensIn: 100, tokensOut: 10, turns: 5 },
      { stage: 5, tokensIn: 200, tokensOut: 20, turns: 10 },
    ]);
    const treatment = measurement("260815", [{ stage: 4, tokensIn: 50, tokensOut: 5, turns: 5 }]);
    const result = compareControlEditions(baseline, treatment);
    const stage5 = result.stages.find((s) => s.stage === 5)!;
    assert.equal(stage5.treatment_tokens_in, null);
    assert.equal(stage5.total_tokens_pct_change, null);
  });
});

describe("formatComparisonReport", () => {
  it("imprime o veredito por extenso (não só números) — case CONFIRMADA", () => {
    const baseline = measurement("260814", [{ stage: 4, tokensIn: 900_000, tokensOut: 100_000, turns: 500 }]);
    const treatment = measurement("260815", [{ stage: 4, tokensIn: 459_000, tokensOut: 51_000, turns: 250 }]);
    const result = compareControlEditions(baseline, treatment);
    const report = formatComparisonReport(result);
    assert.match(report, /HIPÓTESE CONFIRMADA/);
  });

  it("imprime o veredito por extenso — case INVALIDADA, cita revisão da base de 130k tokens/stage", () => {
    const baseline = measurement("260814", [{ stage: 4, tokensIn: 900_000, tokensOut: 100_000, turns: 500 }]);
    const treatment = measurement("260815", [{ stage: 4, tokensIn: 810_000, tokensOut: 90_000, turns: 480 }]);
    const result = compareControlEditions(baseline, treatment);
    const report = formatComparisonReport(result);
    assert.match(report, /HIPÓTESE INVALIDADA/);
    assert.match(report, /130k tokens\/stage/);
  });

  it("relatório NUNCA omite o aviso de contaminação quando presente", () => {
    const contaminated = { ...cleanContamination(), contaminated: true, reasons: ["sessão concorrente ativa"] };
    const baseline = measurement(
      "260814",
      [{ stage: 4, tokensIn: 900_000, tokensOut: 100_000, turns: 500 }],
      contaminated,
    );
    const treatment = measurement("260815", [{ stage: 4, tokensIn: 459_000, tokensOut: 51_000, turns: 250 }]);
    const result = compareControlEditions(baseline, treatment);
    const report = formatComparisonReport(result);
    assert.match(report, /AVISO DE CONFIABILIDADE/);
    assert.match(report, /sessão concorrente ativa/);
  });
});
