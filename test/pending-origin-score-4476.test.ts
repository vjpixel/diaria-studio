/**
 * test/pending-origin-score-4476.test.ts (#4476 item 4)
 *
 * Formaliza a fórmula de score de ORIGEM da fila de entrada do canal Brevo.
 * Fixture pequena com 3 origens (canal próprio de alto desempenho, parceiro
 * mediano, e o pior caso possível) — valores esperados CALCULADOS À MÃO
 * contra a fórmula documentada em `pending-origin-score.ts` (pesos máximos +
 * normalização contra a base + decaimento linear de recência + penalidade
 * linear de bounce).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computePendingOriginScore,
  computeConfirmacaoPoints,
  computeAtivoPoints,
  computeAberturaPoints,
  computeCliquePoints,
  computeRecenciaPoints,
  computeBouncePenalty,
  PENDING_SCORE_BASE_ABERTURA_PCT,
  PENDING_SCORE_BASE_CLIQUE_PCT,
  PENDING_RECENCY_HORIZON_DAYS,
  type PendingOriginMetrics,
} from "../scripts/lib/shared/pending-origin-score.ts";

function closeTo(actual: number, expected: number, msg: string) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: esperado ${expected}, obtido ${actual}`);
}

describe("fatores individuais — pesos máximos (#4476 item 4)", () => {
  it("computeConfirmacaoPoints — linear até o peso máx 25", () => {
    closeTo(computeConfirmacaoPoints(0), 0, "0%");
    closeTo(computeConfirmacaoPoints(100), 25, "100%");
    closeTo(computeConfirmacaoPoints(80), 20, "80% → 20");
  });

  it("computeAtivoPoints — linear até o peso máx 20", () => {
    closeTo(computeAtivoPoints(0), 0, "0%");
    closeTo(computeAtivoPoints(100), 20, "100%");
    closeTo(computeAtivoPoints(60), 12, "60% → 12");
  });

  it(`computeAberturaPoints — normalizado contra a base (${PENDING_SCORE_BASE_ABERTURA_PCT}%), capado em 25`, () => {
    closeTo(computeAberturaPoints(0), 0, "0%");
    closeTo(computeAberturaPoints(PENDING_SCORE_BASE_ABERTURA_PCT), 25, "na base → peso máx");
    closeTo(computeAberturaPoints(PENDING_SCORE_BASE_ABERTURA_PCT * 2), 25, "2x a base → ainda capado em 25 (peso máx)");
    closeTo(computeAberturaPoints(PENDING_SCORE_BASE_ABERTURA_PCT / 2), 12.5, "metade da base → metade do peso");
  });

  it(`computeCliquePoints — normalizado contra a base (${PENDING_SCORE_BASE_CLIQUE_PCT}%), capado em 15`, () => {
    closeTo(computeCliquePoints(0), 0, "0%");
    closeTo(computeCliquePoints(PENDING_SCORE_BASE_CLIQUE_PCT), 15, "na base → peso máx");
    closeTo(computeCliquePoints(PENDING_SCORE_BASE_CLIQUE_PCT / 2), 7.5, "metade da base → metade do peso");
  });

  it(`computeRecenciaPoints — decai linearmente até 0 em ${PENDING_RECENCY_HORIZON_DAYS} dias`, () => {
    closeTo(computeRecenciaPoints(0), 15, "cadastro hoje → peso máx");
    closeTo(computeRecenciaPoints(PENDING_RECENCY_HORIZON_DAYS), 0, "no horizonte → 0");
    closeTo(computeRecenciaPoints(PENDING_RECENCY_HORIZON_DAYS * 2), 0, "além do horizonte → ainda 0 (capado)");
    closeTo(computeRecenciaPoints(-10), 15, "dias negativos (dado corrompido) → tratado como 0 dias, nunca lança");
  });

  it("computeBouncePenalty — linear até -12 no pior caso (100% inválido)", () => {
    closeTo(computeBouncePenalty(0), 0, "0% inválido → sem penalidade");
    closeTo(computeBouncePenalty(100), -12, "100% inválido → -12");
    closeTo(computeBouncePenalty(50), -6, "50% inválido → -6");
  });
});

describe("computePendingOriginScore — fixture de 3 origens, valores calculados à mão (#4476 item 4)", () => {
  it("origem A — canal próprio, alto desempenho em tudo, cadastro recente", () => {
    const m: PendingOriginMetrics = {
      conv_confirmacao_pct: 80,
      conv_ativo_pct: 60,
      abertura_origem_pct: 50, // acima da base (35.8) → capado
      clique_origem_pct: 10, // acima da base (5.2) → capado
      dias_desde_cadastro: 0,
      invalido_origem_pct: 0,
    };
    const out = computePendingOriginScore(m);
    closeTo(out.pts_confirmacao, 20, "pts_confirmacao");
    closeTo(out.pts_ativo, 12, "pts_ativo");
    closeTo(out.pts_abertura, 25, "pts_abertura (capado no peso máx)");
    closeTo(out.pts_clique, 15, "pts_clique (capado no peso máx)");
    closeTo(out.pts_recencia, 15, "pts_recencia (cadastro hoje)");
    closeTo(out.penalidade_bounce, 0, "penalidade_bounce");
    closeTo(out.score, 87, "score total = 20+12+25+15+15+0");
  });

  it("origem B — parceiro mediano, metade da base em abertura/clique, no horizonte de recência, 50% inválido", () => {
    const m: PendingOriginMetrics = {
      conv_confirmacao_pct: 10,
      conv_ativo_pct: 5,
      abertura_origem_pct: PENDING_SCORE_BASE_ABERTURA_PCT / 2,
      clique_origem_pct: PENDING_SCORE_BASE_CLIQUE_PCT / 2,
      dias_desde_cadastro: PENDING_RECENCY_HORIZON_DAYS, // exatamente no horizonte → 0 pts
      invalido_origem_pct: 50,
    };
    const out = computePendingOriginScore(m);
    closeTo(out.pts_confirmacao, 2.5, "pts_confirmacao");
    closeTo(out.pts_ativo, 1, "pts_ativo");
    closeTo(out.pts_abertura, 12.5, "pts_abertura (metade da base)");
    closeTo(out.pts_clique, 7.5, "pts_clique (metade da base)");
    closeTo(out.pts_recencia, 0, "pts_recencia (no horizonte)");
    closeTo(out.penalidade_bounce, -6, "penalidade_bounce");
    closeTo(out.score, 17.5, "score total = 2.5+1+12.5+7.5+0-6");
  });

  it("origem C — pior caso possível (0 em tudo, 100% inválido, idade mediana do pool)", () => {
    const m: PendingOriginMetrics = {
      conv_confirmacao_pct: 0,
      conv_ativo_pct: 0,
      abertura_origem_pct: 0,
      clique_origem_pct: 0,
      dias_desde_cadastro: 218, // idade mediana do pool, issue #4476 item 8
      invalido_origem_pct: 100,
    };
    const out = computePendingOriginScore(m);
    const expectedRecencia = (1 - 218 / PENDING_RECENCY_HORIZON_DAYS) * 15;
    closeTo(out.pts_confirmacao, 0, "pts_confirmacao");
    closeTo(out.pts_ativo, 0, "pts_ativo");
    closeTo(out.pts_abertura, 0, "pts_abertura");
    closeTo(out.pts_clique, 0, "pts_clique");
    closeTo(out.pts_recencia, expectedRecencia, "pts_recencia");
    closeTo(out.penalidade_bounce, -12, "penalidade_bounce (pior caso)");
    closeTo(out.score, expectedRecencia - 12, "score pode ficar NEGATIVO — nunca clampado, só ordena");
    assert.ok(out.score < 0, "pior caso possível deve produzir score negativo");
  });

  it("ordenação: A (canal próprio) > B (parceiro mediano) > C (pior caso)", () => {
    const a = computePendingOriginScore({
      conv_confirmacao_pct: 80, conv_ativo_pct: 60, abertura_origem_pct: 50, clique_origem_pct: 10,
      dias_desde_cadastro: 0, invalido_origem_pct: 0,
    });
    const b = computePendingOriginScore({
      conv_confirmacao_pct: 10, conv_ativo_pct: 5, abertura_origem_pct: PENDING_SCORE_BASE_ABERTURA_PCT / 2,
      clique_origem_pct: PENDING_SCORE_BASE_CLIQUE_PCT / 2, dias_desde_cadastro: PENDING_RECENCY_HORIZON_DAYS, invalido_origem_pct: 50,
    });
    const c = computePendingOriginScore({
      conv_confirmacao_pct: 0, conv_ativo_pct: 0, abertura_origem_pct: 0, clique_origem_pct: 0,
      dias_desde_cadastro: 218, invalido_origem_pct: 100,
    });
    assert.ok(a.score > b.score, "A deve superar B");
    assert.ok(b.score > c.score, "B deve superar C");
  });
});
