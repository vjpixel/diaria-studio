/**
 * overnight-plan-motivo.test.ts (#6438)
 *
 * Espelha `test/develop-plan-motivo.test.ts` (se existir) — cobre o
 * cenário real que motivou a issue: um motivo de `pulada` fora do
 * vocabulário fechado (ex: `mesmo-tema-sessao-ativa` ANTES de #6438 tê-lo
 * fechado) precisa ser reportado pelo gate, e os 3 motivos recém-fechados
 * precisam passar.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OVERNIGHT_PULADA_MOTIVOS,
  isOvernightPuladaMotivo,
  findInvalidPuladaMotivos,
  checkOvernightPlanMotivosFromIssues,
  type OvernightPlanIssueLike,
} from "../scripts/lib/overnight-plan-motivo.ts";

describe("OVERNIGHT_PULADA_MOTIVOS", () => {
  it("inclui os 3 motivos novos fechados pelo #6438", () => {
    assert.ok(isOvernightPuladaMotivo("mesmo-tema-sessao-ativa"));
    assert.ok(isOvernightPuladaMotivo("session-finding-deferida"));
    assert.ok(isOvernightPuladaMotivo("stale-aguarda-reexecucao"));
  });

  it("inclui os motivos legados documentados em prosa no SKILL.md", () => {
    for (const legacy of [
      "sem-resposta",
      "bloqueio-externo",
      "requer-sessao-local",
      "ambigua",
      "not-this-week",
      "fora-do-escopo",
      "sem-direcao-acionavel",
      "claimed-por-outra-sessao",
    ]) {
      assert.ok(isOvernightPuladaMotivo(legacy), `motivo legado "${legacy}" deveria estar no vocabulário`);
    }
  });

  it("rejeita um motivo inventado/typo", () => {
    assert.equal(isOvernightPuladaMotivo("gated-no-D0"), false);
    assert.equal(isOvernightPuladaMotivo(""), false);
  });

  it("não tem duplicatas", () => {
    assert.equal(new Set(OVERNIGHT_PULADA_MOTIVOS).size, OVERNIGHT_PULADA_MOTIVOS.length);
  });
});

describe("findInvalidPuladaMotivos", () => {
  it("cenário real da rodada 260827b: 3 motivos novos passam a validar", () => {
    const issues: OvernightPlanIssueLike[] = [
      { number: 6425, status: "pulada", motivo: "mesmo-tema-sessao-ativa" },
      { number: 6427, status: "pulada", motivo: "mesmo-tema-sessao-ativa" },
      { number: 6259, status: "pulada", motivo: "session-finding-deferida" },
      { number: 5653, status: "pulada", motivo: "stale-aguarda-reexecucao" },
    ];
    assert.deepEqual(findInvalidPuladaMotivos(issues), []);
  });

  it("motivo fora do vocabulário é reportado", () => {
    const issues: OvernightPlanIssueLike[] = [
      { number: 100, status: "pulada", motivo: "gated-no-D0" },
    ];
    assert.deepEqual(findInvalidPuladaMotivos(issues), [{ number: 100, motivo: "gated-no-D0" }]);
  });

  it("motivo ausente/não-string é reportado como null", () => {
    const issues: OvernightPlanIssueLike[] = [
      { number: 101, status: "pulada" },
      { number: 102, status: "pulada", motivo: 42 },
    ];
    assert.deepEqual(findInvalidPuladaMotivos(issues), [
      { number: 101, motivo: null },
      { number: 102, motivo: null },
    ]);
  });

  it("issues não-puladas nunca entram na varredura", () => {
    const issues: OvernightPlanIssueLike[] = [
      { number: 1, status: "mergeada", motivo: "qualquer-coisa" },
      { number: 2, status: "elegivel" },
    ];
    assert.deepEqual(findInvalidPuladaMotivos(issues), []);
  });
});

describe("checkOvernightPlanMotivosFromIssues", () => {
  it("ok quando tudo está no vocabulário", () => {
    const result = checkOvernightPlanMotivosFromIssues([
      { number: 1, status: "pulada", motivo: "bloqueio-externo" },
    ]);
    assert.deepEqual(result, { status: "ok" });
  });

  it("invalid, ordenado por número, quando há entrada fora do vocabulário", () => {
    const result = checkOvernightPlanMotivosFromIssues([
      { number: 200, status: "pulada", motivo: "inventado-b" },
      { number: 100, status: "pulada", motivo: "inventado-a" },
    ]);
    assert.deepEqual(result, {
      status: "invalid",
      entries: [
        { number: 100, motivo: "inventado-a" },
        { number: 200, motivo: "inventado-b" },
      ],
    });
  });
});
