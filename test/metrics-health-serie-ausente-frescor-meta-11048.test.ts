/**
 * test/metrics-health-serie-ausente-frescor-meta-11048.test.ts (#11048)
 *
 * O #10994 congelou só a chave `queda:` da métrica sem série. As issues
 * `frescor:X`, `meta-nao-atingida:X` e `indeterminado-alto:X` seguiam lendo
 * "ausência = resolvido" e fechavam enquanto o dado estava ainda mais velho.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planAlarmReconciliation, type AlarmIssuesState } from "../scripts/lib/alarm-issues.ts";
import { serieAusenteNaoAvaliadaKeys } from "../scripts/check-metrics-health.ts";

const WIRED = ["cadastros-dia", "base-ativa", "leitor-v1"] as const;
const seriesById = new Map<string, unknown[]>([["cadastros-dia", [{}]]]);
const metas = [{ metrica_id: "leitor-v1" }, { metrica_id: "cadastros-dia" }];

function aberta(key: string, missingStreak: number): AlarmIssuesState {
  return { [key]: { issueNumber: 4242, url: "https://example.invalid/4242", missingStreak, closedAt: null, family: "estado" } };
}

describe("#11048 — série ausente congela frescor e metas", () => {
  const keys = serieAusenteNaoAvaliadaKeys(WIRED, seriesById, metas);
  const isUnmeasured = (k: string) => keys.has(k);

  it("REGRESSÃO (pré-condição): sem congelar, frescor e meta fecham por ausência", () => {
    for (const k of ["metrics-health:frescor:base-ativa", "metrics-health:meta-nao-atingida:leitor-v1"]) {
      assert.deepEqual(planAlarmReconciliation([], aberta(k, 1), 2).map((a) => a.kind), ["close"]);
    }
  });

  it("chaves de frescor e de meta da métrica sem série entram; as de métrica com série não", () => {
    assert.ok(keys.has("metrics-health:frescor:base-ativa"));
    assert.ok(keys.has("metrics-health:frescor:leitor-v1"));
    assert.ok(keys.has("metrics-health:meta-nao-atingida:leitor-v1"));
    assert.ok(keys.has("metrics-health:indeterminado-alto:leitor-v1"));
    assert.ok(!keys.has("metrics-health:frescor:cadastros-dia"));
    assert.ok(!keys.has("metrics-health:meta-nao-atingida:cadastros-dia"));
  });

  it("issue frescor:X e de meta abertas: nenhuma ação em nenhum streak", () => {
    for (const k of ["metrics-health:frescor:base-ativa", "metrics-health:meta-nao-atingida:leitor-v1"]) {
      for (const streak of [0, 1, 5]) {
        assert.deepEqual(planAlarmReconciliation([], aberta(k, streak), 2, [], isUnmeasured), []);
      }
    }
  });

  it("métrica com série segue o fluxo normal", () => {
    assert.deepEqual(
      planAlarmReconciliation([], aberta("metrics-health:frescor:cadastros-dia", 0), 2, [], isUnmeasured).map((a) => a.kind),
      ["comment_resolved"],
    );
  });
});
