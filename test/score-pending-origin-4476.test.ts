/**
 * test/score-pending-origin-4476.test.ts (#4476 item 4)
 *
 * Orquestração I/O de `score-pending-origin.ts` (parse de linha crua +
 * ordenação) — a fórmula pura em si é testada em
 * `test/pending-origin-score-4476.test.ts`. Fixture com 3 origens (mesmos
 * valores do teste da fórmula, calculados à mão) verificando que o parse do
 * CSV e a ordenação descendente produzem o resultado esperado.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseInputRow, scoreAndSortRows, detectPercentScaleAnomaly } from "../scripts/score-pending-origin.ts";
import type { PendingOriginMetrics } from "../scripts/lib/shared/pending-origin-score.ts";

describe("parseInputRow — parse defensivo de linha crua (#4476 item 4)", () => {
  it("linha bem-formada → tipada corretamente", () => {
    const row = parseInputRow(
      {
        email: "  Foo@Bar.COM  ",
        origin: "canal-proprio",
        conv_confirmacao_pct: "80",
        conv_ativo_pct: "60",
        abertura_origem_pct: "50",
        clique_origem_pct: "10",
        dias_desde_cadastro: "0",
        invalido_origem_pct: "0",
      },
      2,
    );
    assert.equal(row.email, "foo@bar.com", "email normalizado (lowercase/trim)");
    assert.equal(row.origin, "canal-proprio");
    assert.equal(row.conv_confirmacao_pct, 80);
    assert.equal(row.dias_desde_cadastro, 0);
  });

  it("email ausente/vazio → lança com número da linha", () => {
    assert.throws(
      () => parseInputRow({ email: "", origin: "x", conv_confirmacao_pct: "1", conv_ativo_pct: "1", abertura_origem_pct: "1", clique_origem_pct: "1", dias_desde_cadastro: "1", invalido_origem_pct: "1" }, 5),
      /linha 5.*email/,
    );
  });

  it("campo numérico ausente → lança nomeando o campo e o email", () => {
    assert.throws(
      () => parseInputRow({ email: "a@b.com", origin: "x", conv_confirmacao_pct: "1", conv_ativo_pct: "1", abertura_origem_pct: "1", clique_origem_pct: "1", invalido_origem_pct: "1" } as Record<string, string>, 3),
      /linha 3 \(a@b\.com\).*dias_desde_cadastro/,
    );
  });

  it("campo numérico não-numérico (ex: string vazia coagida a NaN) → lança", () => {
    assert.throws(
      () => parseInputRow({ email: "a@b.com", origin: "x", conv_confirmacao_pct: "abc", conv_ativo_pct: "1", abertura_origem_pct: "1", clique_origem_pct: "1", dias_desde_cadastro: "1", invalido_origem_pct: "1" }, 4),
      /conv_confirmacao_pct/,
    );
  });

  it("origin ausente → string vazia (não lança — origin é identidade, não entra na fórmula)", () => {
    const row = parseInputRow(
      { email: "a@b.com", conv_confirmacao_pct: "0", conv_ativo_pct: "0", abertura_origem_pct: "0", clique_origem_pct: "0", dias_desde_cadastro: "0", invalido_origem_pct: "0" } as Record<string, string>,
      2,
    );
    assert.equal(row.origin, "");
  });
});

describe("scoreAndSortRows — fixture de 3 origens, ordenação descendente (#4476 item 4)", () => {
  it("ordena por score DESCENDENTE (maior prioridade primeiro)", () => {
    const rows = [
      // C — pior caso, deve terminar por último
      { email: "c@b.com", origin: "off-topic", conv_confirmacao_pct: 0, conv_ativo_pct: 0, abertura_origem_pct: 0, clique_origem_pct: 0, dias_desde_cadastro: 218, invalido_origem_pct: 100 },
      // A — canal próprio, deve terminar primeiro
      { email: "a@b.com", origin: "canal-proprio", conv_confirmacao_pct: 80, conv_ativo_pct: 60, abertura_origem_pct: 50, clique_origem_pct: 10, dias_desde_cadastro: 0, invalido_origem_pct: 0 },
      // B — parceiro mediano, deve terminar no meio
      { email: "b@b.com", origin: "parceiro", conv_confirmacao_pct: 10, conv_ativo_pct: 5, abertura_origem_pct: 17.9, clique_origem_pct: 2.6, dias_desde_cadastro: 365, invalido_origem_pct: 50 },
    ];
    const out = scoreAndSortRows(rows);
    assert.equal(out.length, 3);
    assert.equal(out[0].email, "a@b.com", "canal próprio primeiro (score mais alto)");
    assert.equal(out[1].email, "b@b.com", "parceiro mediano no meio");
    assert.equal(out[2].email, "c@b.com", "pior caso por último");
    assert.ok(out[0].score > out[1].score);
    assert.ok(out[1].score > out[2].score);
    // score total de A calculado à mão (mesmo fixture de test/pending-origin-score-4476.test.ts)
    assert.ok(Math.abs(out[0].score - 87) < 1e-9, `score de A deveria ser 87, obtido ${out[0].score}`);
  });

});

describe("detectPercentScaleAnomaly — sinal de divergência de escala (#4476 achado silent-failure-hunter)", () => {
  function row(overrides: Partial<PendingOriginMetrics> = {}): PendingOriginMetrics {
    return {
      conv_confirmacao_pct: 0,
      conv_ativo_pct: 0,
      abertura_origem_pct: 0,
      clique_origem_pct: 0,
      dias_desde_cadastro: 100, // não é campo de percentual, nunca entra na checagem
      invalido_origem_pct: 0,
      ...overrides,
    };
  }

  it("escala 0-100 normal (pelo menos 1 valor >1) → sem anomalia", () => {
    assert.equal(detectPercentScaleAnomaly([row({ conv_confirmacao_pct: 80 }), row({ abertura_origem_pct: 17.9 })]), false);
  });

  it("todos os campos de percentual >0 caem em [0,1] → anomalia (possível fração em vez de 0-100)", () => {
    assert.equal(
      detectPercentScaleAnomaly([row({ conv_confirmacao_pct: 0.8, conv_ativo_pct: 0.6 }), row({ abertura_origem_pct: 0.179 })]),
      true,
    );
  });

  it("amostra toda zerada → sem anomalia (nada pra suspeitar)", () => {
    assert.equal(detectPercentScaleAnomaly([row(), row()]), false);
  });

  it("amostra vazia → sem anomalia", () => {
    assert.equal(detectPercentScaleAnomaly([]), false);
  });

  it("1 único valor >1 em meio a vários <=1 já desarma o sinal (basta 1 contraexemplo)", () => {
    assert.equal(
      detectPercentScaleAnomaly([row({ conv_confirmacao_pct: 0.5 }), row({ conv_ativo_pct: 0.9 }), row({ clique_origem_pct: 5.2 })]),
      false,
    );
  });

  it("dias_desde_cadastro NUNCA entra na checagem (não é percentual) — valor grande não desarma nem aciona o sinal sozinho", () => {
    assert.equal(detectPercentScaleAnomaly([row({ dias_desde_cadastro: 400, conv_confirmacao_pct: 0.5 })]), true);
  });

  it("exatamente 1.0 NÃO conta como '>1' — ainda soma pra anomalia (borda inclusiva do [0,1])", () => {
    assert.equal(detectPercentScaleAnomaly([row({ conv_confirmacao_pct: 1 })]), true);
  });
});

describe("scoreAndSortRows — breakdown por linha (#4476 item 4)", () => {
  it("cada linha de saída carrega o breakdown completo (pts_* + penalidade + score)", () => {
    const out = scoreAndSortRows([
      { email: "a@b.com", origin: "x", conv_confirmacao_pct: 100, conv_ativo_pct: 100, abertura_origem_pct: 100, clique_origem_pct: 100, dias_desde_cadastro: 0, invalido_origem_pct: 0 },
    ]);
    assert.equal(out[0].pts_confirmacao, 25);
    assert.equal(out[0].pts_ativo, 20);
    assert.equal(out[0].pts_abertura, 25);
    assert.equal(out[0].pts_clique, 15);
    assert.equal(out[0].pts_recencia, 15);
    assert.equal(out[0].penalidade_bounce, 0);
    assert.equal(out[0].score, 100, "melhor caso teórico → 100 exato");
  });
});
