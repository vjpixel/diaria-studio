/**
 * test/round-diff-stats-report.test.ts (#7292)
 *
 * Regressão: a issue #7292 mediu que a "janela de 7 dias" citada no título
 * do alarme era, na prática, UMA rodada só (`n=1`) — o texto prometia
 * agregação de tendência e entregava um ponto. Segundo achado: `--check-alarm`
 * imprimia a MESMA frase de saída ("sem alarme") tanto quando a razão de 7d
 * era saudável quanto quando não havia NENHUMA rodada medida na janela
 * (`rounds === 0`) — silêncio verde indistinguível nos dois casos.
 *
 * Dado sintético — sem bater em `git`/`run-log.jsonl` real (mesma disciplina
 * de test/round-diff-stats.test.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRoundDiffRatioFinding, classifyCheckAlarmState } from "../scripts/round-diff-stats-report.ts";
import type { WindowedRoundDiffStats } from "../scripts/lib/round-diff-stats.ts";

function window7d(overrides: Partial<WindowedRoundDiffStats> = {}): WindowedRoundDiffStats {
  return {
    windowDays: 7,
    rounds: 1,
    added: 15335,
    removed: 1002,
    ratio: 15335 / 1002,
    net: 14333,
    netPerDay: 14333 / 7,
    ...overrides,
  };
}

describe("buildRoundDiffRatioFinding (#7292 — n declarado, 'janela' só com n>=2)", () => {
  it("n=1 (caso real que abriu a #7292): título e corpo falam 'uma rodada', nunca 'janela'", () => {
    const finding = buildRoundDiffRatioFinding(15335 / 1002, 15335, 14333 / 7, 1);
    assert.match(finding.title, /uma rodada/);
    assert.doesNotMatch(finding.title, /janela/);
    assert.match(finding.body, /n=1/);
    assert.doesNotMatch(finding.body, /janela dos últimos 7 dias/);
  });

  it("n>=2: título e corpo falam 'janela', com a contagem de rodadas explícita", () => {
    const finding = buildRoundDiffRatioFinding(36, 5042, 5042 / 7, 3);
    assert.match(finding.title, /janela de 7 dias/);
    assert.match(finding.body, /n=3 rodadas/);
  });

  it("ainda cita o limiar e o líquido/dia (comportamento pré-#7292 preservado)", () => {
    const finding = buildRoundDiffRatioFinding(20, 1000, 100, 2);
    assert.match(finding.body, /10:1/);
    assert.match(finding.body, /100/);
  });
});

describe("classifyCheckAlarmState (#7292 — distingue 'sem dado' de 'razão saudável')", () => {
  it("rounds === 0 → estado 'no-data', NUNCA confundido com 'sem alarme'/saudável", () => {
    const result = classifyCheckAlarmState(window7d({ rounds: 0, added: 0, removed: 0, ratio: null, net: 0, netPerDay: 0 }));
    assert.equal(result.state, "no-data");
    assert.match(result.message, /sem dado/);
    assert.doesNotMatch(result.message, /dentro do limiar/);
  });

  it("rounds > 0 e ratio abaixo do limiar → estado 'healthy', menciona n explicitamente", () => {
    const result = classifyCheckAlarmState(window7d({ rounds: 4, added: 100, removed: 50, ratio: 2, netPerDay: 50 / 7 }));
    assert.equal(result.state, "healthy");
    assert.match(result.message, /n=4/);
    assert.match(result.message, /dentro do limiar/);
  });

  it("rounds > 0 e ratio no/acima do limiar → estado 'alarming' (mensagem vazia, cabe ao caller montar o finding)", () => {
    const result = classifyCheckAlarmState(window7d({ rounds: 1, ratio: 15 }));
    assert.equal(result.state, "alarming");
  });

  it("caso real #7292 (15,3:1, n=1) classifica alarming — mas o texto do finding sabe que n=1 (coberto no describe acima)", () => {
    const result = classifyCheckAlarmState(window7d());
    assert.equal(result.state, "alarming");
  });
});
