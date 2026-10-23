/**
 * test/metrics-health-serie-ausente-10994.test.ts (#10994)
 *
 * O #10662 congelou a issue `queda:` quando `evaluateQueda` pula. Mas a métrica
 * sem série nenhuma (falha de ingestão) saía do loop por `if (!medicoes)
 * continue;` antes de entrar em `quedaAvaliacoes` — a issue aberta dela não era
 * congelada e a reconciliação contava a ausência como "não reproduz mais",
 * fechando-a depois de N execuções.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planAlarmReconciliation, type AlarmIssuesState } from "../scripts/lib/alarm-issues.ts";
import { quedaAvaliacoesSemSerie, quedaNaoAvaliadaKeys } from "../scripts/check-metrics-health.ts";

const WIRED = ["cadastros-dia", "base-ativa", "leitor-v1"] as const;
const KEY_BASE = "metrics-health:queda:base-ativa";

function stateComIssueAberta(key: string, missingStreak: number): AlarmIssuesState {
  return { [key]: { issueNumber: 4242, url: "https://example.invalid/4242", missingStreak, closedAt: null, family: "estado" } };
}

describe("#10994 — métrica sem série não fecha a issue de queda aberta", () => {
  // Snapshot da Beehiiv ausente: base-ativa e leitor-v1 sem série; cadastros-dia com série.
  const seriesById = new Map<string, unknown[]>([["cadastros-dia", [{}]]]);

  it("REGRESSÃO (pré-condição): sem registrar a métrica, a ausência comenta 'resolvido' e depois fecha", () => {
    assert.deepEqual(planAlarmReconciliation([], stateComIssueAberta(KEY_BASE, 0), 2).map((a) => a.kind), ["comment_resolved"]);
    assert.deepEqual(planAlarmReconciliation([], stateComIssueAberta(KEY_BASE, 1), 2).map((a) => a.kind), ["close"]);
  });

  it("quedaAvaliacoesSemSerie devolve skipMotivo 'série ausente' só para quem não tem série", () => {
    const avaliacoes = quedaAvaliacoesSemSerie(WIRED, seriesById);
    assert.deepEqual(
      avaliacoes.map((a) => a.metricaId),
      ["base-ativa", "leitor-v1"],
    );
    for (const a of avaliacoes) assert.match(a.skipMotivo, /série ausente/);
  });

  it("com as avaliações de série ausente: nenhuma ação sobre a issue aberta, em nenhum streak", () => {
    const keys = quedaNaoAvaliadaKeys(quedaAvaliacoesSemSerie(WIRED, seriesById));
    assert.ok(keys.has(KEY_BASE));
    assert.ok(keys.has("metrics-health:queda:leitor-v1"));
    assert.ok(!keys.has("metrics-health:queda:cadastros-dia"));
    for (const streak of [0, 1, 5]) {
      assert.deepEqual(planAlarmReconciliation([], stateComIssueAberta(KEY_BASE, streak), 2, [], (k) => keys.has(k)), []);
    }
  });

  it("métrica COM série segue o fluxo normal de resolução", () => {
    const keys = quedaNaoAvaliadaKeys(quedaAvaliacoesSemSerie(WIRED, seriesById));
    const k = "metrics-health:queda:cadastros-dia";
    assert.deepEqual(
      planAlarmReconciliation([], stateComIssueAberta(k, 0), 2, [], (x) => keys.has(x)).map((a) => a.kind),
      ["comment_resolved"],
    );
  });

  it("todas com série -> nenhuma avaliação de série ausente", () => {
    const todas = new Map<string, unknown[]>(WIRED.map((id) => [id, []]));
    assert.deepEqual(quedaAvaliacoesSemSerie(WIRED, todas), []);
  });
});
