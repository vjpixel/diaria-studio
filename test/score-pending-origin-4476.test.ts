/**
 * test/score-pending-origin-4476.test.ts (#4476 item 4, reescrito 260802)
 *
 * `score-pending-origin.ts` mudou de "recalcula o score a partir de métricas
 * cruas" pra "lê + valida + ordena o score já presente no CSV manual" — ver
 * justificativa no header do módulo (a reimplementação divergia
 * materialmente do score confirmado quando testada contra os 627 registros
 * reais). Testes cobrem o parse defensivo (`parseScoredRow`) e a ordenação
 * (`sortByScoreDescending`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseScoredRow, sortByScoreDescending, SCORE_SUM_TOLERANCE, LANE_RECENCY } from "../scripts/score-pending-origin.ts";

function rawRow(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    email: "a@b.com",
    origem: "canal-proprio",
    score: "78.7",
    pts_confirmacao: "21.2",
    pts_ativo: "14.4",
    pts_abertura: "17.2",
    pts_clique: "12.1",
    pts_recencia: "14.3",
    penalidade_bounce: "-0.5",
    ...overrides,
  };
}

describe("parseScoredRow — parse defensivo + checagem de consistência (#4476 item 4, 260802)", () => {
  it("linha bem-formada → tipada corretamente, email normalizado", () => {
    const row = parseScoredRow(rawRow({ email: "  Foo@Bar.COM  " }), 2);
    assert.equal(row.email, "foo@bar.com");
    assert.equal(row.origin, "canal-proprio");
    assert.equal(row.score, 78.7);
    assert.equal(row.pts_confirmacao, 21.2);
    assert.equal(row.penalidade_bounce, -0.5);
  });

  it("email ausente/vazio → lança com número da linha", () => {
    assert.throws(() => parseScoredRow(rawRow({ email: "" }), 5), /linha 5.*email/);
  });

  it("origem ausente/vazia → lança (mesma disciplina fail-loud do email)", () => {
    assert.throws(() => parseScoredRow(rawRow({ origem: "" }), 2), /linha 2 \(a@b\.com\).*origem/);
  });

  it("score ausente/não-numérico → lança nomeando o campo e o email", () => {
    assert.throws(() => parseScoredRow(rawRow({ score: "abc" }), 3), /linha 3 \(a@b\.com\).*score/);
  });

  it("um pts_* ausente/não-numérico → lança nomeando o campo", () => {
    assert.throws(() => parseScoredRow(rawRow({ pts_clique: "" }), 4), /linha 4 \(a@b\.com\).*pts_clique/);
  });

  it("soma dos pts_* bate com score dentro da tolerância → ok (arredondamento normal, 1 casa decimal por campo)", () => {
    // 21.2+14.4+17.2+12.1+14.3-0.5 = 78.7 exato — sem folga usada.
    const row = parseScoredRow(rawRow(), 2);
    assert.equal(row.score, 78.7);
  });

  it(`soma diverge do score além de ${SCORE_SUM_TOLERANCE} → lança (dado inconsistente, não ordenar sem investigar)`, () => {
    assert.throws(
      () => parseScoredRow(rawRow({ score: "50.0" }), 2), // soma real é 78.7, longe de 50.0
      /linha 2 \(a@b\.com\).*soma dos pts_.*diverge/,
    );
  });

  it(`fronteira exata: diff de EXATAMENTE ${SCORE_SUM_TOLERANCE} → NÃO lança (checagem é estritamente >)`, () => {
    // soma real = 78.7; score = 78.7 - 0.5 = 78.2 → diff exato = 0.5
    assert.doesNotThrow(() => parseScoredRow(rawRow({ score: "78.2" }), 2));
  });

  it(`fronteira exata: diff de ${SCORE_SUM_TOLERANCE + 0.01} (1 centésimo acima) → lança`, () => {
    // soma real = 78.7; score = 78.7 - 0.51 = 78.19
    assert.throws(() => parseScoredRow(rawRow({ score: "78.19" }), 2), /diverge/);
  });

  it("direção simétrica: score MAIOR que a soma também lança além da tolerância (Math.abs, não só sum > score)", () => {
    // soma real = 78.7; score = 78.7 + 10 = 88.7 (score acima da soma, não abaixo)
    assert.throws(() => parseScoredRow(rawRow({ score: "88.7" }), 2), /diverge/);
  });
});

describe("parseScoredRow — colunas lane/subscribed_on opcionais e retrocompatíveis (#5183)", () => {
  it("CSV antigo sem as colunas → lane e subscribed_on viram '' (nunca lança)", () => {
    const row = parseScoredRow(rawRow(), 2);
    assert.equal(row.lane, "");
    assert.equal(row.subscribed_on, "");
  });

  it("linha com lane=recency e subscribed_on preenchidos → lidos corretamente", () => {
    const row = parseScoredRow(rawRow({ lane: LANE_RECENCY, subscribed_on: "2026-08-14T00:00:00.000Z" }), 2);
    assert.equal(row.lane, LANE_RECENCY);
    assert.equal(row.subscribed_on, "2026-08-14T00:00:00.000Z");
  });

  it("lane/subscribed_on trimados", () => {
    const row = parseScoredRow(rawRow({ lane: "  recency  ", subscribed_on: "  2026-08-14T00:00:00.000Z  " }), 2);
    assert.equal(row.lane, "recency");
    assert.equal(row.subscribed_on, "2026-08-14T00:00:00.000Z");
  });
});

describe("sortByScoreDescending — ordena por score, maior prioridade primeiro (#4476 item 4)", () => {
  it("ordena 3 linhas por score DESCENDENTE, sem mutar o array original", () => {
    const rows = [
      parseScoredRow(rawRow({ email: "low@b.com", score: "15.6", pts_confirmacao: "5", pts_ativo: "4", pts_abertura: "3", pts_clique: "2", pts_recencia: "3.6", penalidade_bounce: "-2" }), 2),
      parseScoredRow(rawRow({ email: "high@b.com" }), 3), // 78.7
      parseScoredRow(rawRow({ email: "mid@b.com", score: "40.0", pts_confirmacao: "10", pts_ativo: "8", pts_abertura: "10", pts_clique: "6", pts_recencia: "8", penalidade_bounce: "-2" }), 4),
    ];
    const original = [...rows];
    const sorted = sortByScoreDescending(rows);
    assert.deepEqual(sorted.map((r) => r.email), ["high@b.com", "mid@b.com", "low@b.com"]);
    assert.deepEqual(rows, original, "não muta o array de entrada");
  });
});
