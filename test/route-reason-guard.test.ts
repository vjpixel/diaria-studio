/**
 * test/route-reason-guard.test.ts (#7288 Parte A)
 *
 * Cobre `scripts/lib/route-reason-guard.ts` — `detectNonDateReason`. O
 * corpus principal é o item explícito do "Escopo" da #7288: "os 11 motivos
 * reais desta auditoria como corpus de regressão... o último item é o que
 * fecha o loop do #633 — os casos existem, medidos, e não precisam ser
 * inventados." Cada caso abaixo é uma paráfrase fiel do motivo real citado
 * na issue (mesma família/vocabulário), mapeado à issue original.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectNonDateReason } from "../scripts/lib/route-reason-guard.ts";

describe("detectNonDateReason — corpus de regressão da auditoria #7288 (11 motivos reais)", () => {
  const dependencyCases: Array<[string, string]> = [
    ["#6771", "segurar até o #6716 fechar antes de reavaliar"],
    ["#7043", "mesma cautela que já adia #6621/#6623 — segurar até o cluster fechar"],
    ["#6624", "mesma cautela do cluster #6621/#6623"],
  ];
  for (const [issue, reason] of dependencyCases) {
    it(`${issue}: "${reason}" -> categoria dependencia`, () => {
      const finding = detectNonDateReason(reason);
      assert.ok(finding, "esperava um finding");
      assert.equal(finding?.category, "dependencia");
      assert.match(finding?.message ?? "", /depends-on/);
    });
  }

  const conditionalCases: Array<[string, string]> = [
    ["#7036", "só morde quando a assinatura da API voltar a funcionar"],
    ["#6783", "reavaliar só se a assinatura recorrer"],
  ];
  for (const [issue, reason] of conditionalCases) {
    it(`${issue}: "${reason}" -> categoria gatilho-condicional`, () => {
      const finding = detectNonDateReason(reason);
      assert.ok(finding, "esperava um finding");
      assert.equal(finding?.category, "gatilho-condicional");
      assert.match(finding?.message ?? "", /track bloqueada/);
    });
  }

  const scopeCases: Array<[string, string]> = [
    ["#7206", "fatia própria — merece issue dedicada, não cabe nesta rodada"],
    ["#7204", "grande demais pra uma unidade de rodada, fatiar depois"],
    ["#7137", "escopo residual — fatia própria do trabalho maior"],
    ["#7201", "fatia própria do épico, tamanho grande demais"],
  ];
  for (const [issue, reason] of scopeCases) {
    it(`${issue}: "${reason}" -> categoria escopo`, () => {
      const finding = detectNonDateReason(reason);
      assert.ok(finding, "esperava um finding");
      assert.equal(finding?.category, "escopo");
      assert.match(finding?.message ?? "", /gh issue create/);
    });
  }

  // O 11º motivo real (#6674) era EM BRANCO — não tem padrão de texto pra
  // detectar (é ausência, não conteúdo). `detectNonDateReason` não cobre
  // esse caso de propósito: `routeIssue` (scripts/route-issue.ts) recusa
  // reason vazio ANTES de chamar esta função, incondicionalmente (sem
  // --force possível) — ver describe("routeIssue — reason obrigatório...")
  // em test/issue-route.test.ts.
  it("motivo em branco não é responsabilidade desta função (null, nunca lança)", () => {
    assert.equal(detectNonDateReason(""), null);
  });
});

describe("detectNonDateReason — razão que É uma data legítima passa", () => {
  it("razão que só descreve o EVENTO externo esperado (sem citar #N nem gatilho vago) não é recusada", () => {
    assert.equal(detectNonDateReason("aguardando resposta da Beehiiv sobre o plano Scale"), null);
    assert.equal(detectNonDateReason("aguardando o fechamento do ciclo Clarice T1-W4"), null);
  });
});

describe("detectNonDateReason — ordem de checagem quando mais de 1 padrão bate", () => {
  it('"mesma cautela que #6621" bate dependencia (mais especifica) e nao gatilho-condicional', () => {
    const finding = detectNonDateReason("mesma cautela que #6621, segurar até fechar");
    assert.equal(finding?.category, "dependencia");
  });
});
