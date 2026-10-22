/**
 * test/metrics-health-skip-freeze-10662.test.ts (#10662)
 *
 * Com a janela paga encerrada tirando dias da baseline, `evaluateQueda` pula
 * (`skipMotivo`) em vez de avaliar. A reconciliação recebia só os findings e
 * tratava o skip como "sinal sumiu": a issue de queda aberta antes ganhava
 * "não reproduz mais" e fechava depois de 2 execuções, sem a queda ter sido
 * reavaliada uma única vez.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MetricDef, Janela } from "../scripts/lib/metrics/registry.ts";
import { evaluateQueda, METRICS_HEALTH_THRESHOLDS, type MedicaoDia } from "../scripts/lib/metrics/health.ts";
import { planAlarmReconciliation, type AlarmIssuesState } from "../scripts/lib/alarm-issues.ts";
import { quedaNaoAvaliadaKeys } from "../scripts/check-metrics-health.ts";

const DEF: Pick<MetricDef, "id" | "nome" | "direcao" | "unidade"> = {
  id: "cadastros-dia",
  nome: "Cadastros por dia",
  direcao: "maior-melhor",
  unidade: "contagem",
};

function janela(dia: string): Janela {
  return { de: dia, ate: dia, granularidade: "dia", fuso: "BRT" };
}

function exato(dia: string, valor: number): MedicaoDia {
  return { chave: dia, resultado: { valor, janela: janela(dia), frescor: dia, qualidade: "exato", motivo: null } };
}

function dias14(hoje: string): string[] {
  const out: string[] = [];
  const [y, m, d] = hoje.split("-").map(Number);
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - i);
    out.push(dt.toISOString().slice(0, 10));
  }
  return out;
}

const KEY = "metrics-health:queda:cadastros-dia";

function stateComIssueAberta(missingStreak: number): AlarmIssuesState {
  return {
    [KEY]: { issueNumber: 9999, url: "https://example.invalid/9999", missingStreak, closedAt: null, family: "estado" },
  };
}

describe("#10662 — queda pulada por baseline curta não fecha a issue aberta", () => {
  const dias = dias14("2026-10-20");
  // Janela paga cobrindo os dias 0-10: sobra baseline de 2 dias (< MIN_DIAS_BASELINE=5).
  const serie = dias.map((d, i) => exato(d, i < 11 ? 25 : i === dias.length - 1 ? 0 : 10));
  const janelaPaga = { de: dias[0], ate: dias[10], motivo: "(teste pago)" };

  it("o cenário real pula a queda (pré-condição)", () => {
    const { finding, skipMotivo } = evaluateQueda(DEF, serie, dias, METRICS_HEALTH_THRESHOLDS, {
      baselineExcluida: [janelaPaga],
    });
    assert.equal(finding, null);
    assert.match(skipMotivo!, /baseline curta/);
  });

  it("REGRESSÃO: sem o congelamento, o skip comenta 'resolvido' e depois fecha", () => {
    assert.deepEqual(
      planAlarmReconciliation([], stateComIssueAberta(0), 2).map((a) => a.kind),
      ["comment_resolved"],
    );
    assert.deepEqual(planAlarmReconciliation([], stateComIssueAberta(1), 2).map((a) => a.kind), ["close"]);
  });

  it("com quedaNaoAvaliadaKeys: nenhuma ação sobre a issue aberta", () => {
    const { skipMotivo } = evaluateQueda(DEF, serie, dias, METRICS_HEALTH_THRESHOLDS, {
      baselineExcluida: [janelaPaga],
    });
    const keys = quedaNaoAvaliadaKeys([{ metricaId: DEF.id, skipMotivo }]);
    assert.deepEqual([...keys], [KEY]);
    for (const streak of [0, 1]) {
      const actions = planAlarmReconciliation([], stateComIssueAberta(streak), 2, [], (k) => keys.has(k));
      assert.deepEqual(actions, []);
    }
  });

  it("skip 'todos os dias excluídos' também congela", () => {
    const tudo = { de: dias[0], ate: dias[12], motivo: "(teste pago)" };
    const { skipMotivo } = evaluateQueda(DEF, serie, dias, METRICS_HEALTH_THRESHOLDS, { baselineExcluida: [tudo] });
    assert.ok(skipMotivo);
    assert.ok(quedaNaoAvaliadaKeys([{ metricaId: DEF.id, skipMotivo }]).has(KEY));
  });

  it("queda avaliada sem achado (skipMotivo null) segue o fluxo normal de resolução", () => {
    const keys = quedaNaoAvaliadaKeys([{ metricaId: DEF.id, skipMotivo: null }]);
    assert.equal(keys.size, 0);
    assert.deepEqual(
      planAlarmReconciliation([], stateComIssueAberta(0), 2, [], (k) => keys.has(k)).map((a) => a.kind),
      ["comment_resolved"],
    );
  });

  it("congela só a queda da métrica pulada — outros sinais da mesma métrica seguem normais", () => {
    const keys = quedaNaoAvaliadaKeys([{ metricaId: DEF.id, skipMotivo: "baseline curta" }]);
    const state: AlarmIssuesState = {
      ...stateComIssueAberta(0),
      "metrics-health:frescor:cadastros-dia": {
        issueNumber: 1,
        url: "https://example.invalid/1",
        missingStreak: 0,
        closedAt: null,
        family: "estado",
      },
    };
    const actions = planAlarmReconciliation([], state, 2, [], (k) => keys.has(k));
    assert.deepEqual(
      actions.map((a) => ("key" in a ? a.key : null)),
      ["metrics-health:frescor:cadastros-dia"],
    );
  });
});
