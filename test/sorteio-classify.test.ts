/**
 * sorteio-classify.test.ts (#929)
 *
 * Testa o classificador puro de respostas do sorteio. Foca em:
 *   - Inferência de edição via regex (`guessEditionFromBody`)
 *   - Heurística de error_type (`guessErrorType`)
 *   - Cross-reference com gabarito (`classifyGabarito`)
 *   - Recomendação editorial (`recommend`)
 *   - Pipeline completo (`classify`) com dedup e classificação fim-a-fim.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  guessEditionFromBody,
  guessErrorType,
  classifyGabarito,
  recommend,
  classify,
  type RawThread,
} from "../scripts/sorteio-classify.ts";
import type { IntentionalError } from "../scripts/lib/intentional-errors.ts";

describe("guessEditionFromBody — extrai AAMMDD do corpo (#929)", () => {
  it("captura formato `/edicao/AAMMDD`", () => {
    assert.equal(
      guessEditionFromBody("vi em https://diar.ia.br/edicao/260505 e achei o erro"),
      "260505",
    );
  });

  it("captura `edição AAMMDD` em PT-BR", () => {
    assert.equal(
      guessEditionFromBody("Na edição 260507 tem um erro no destaque 2"),
      "260507",
    );
  });

  it("captura menção via diar.ia próximo a AAMMDD", () => {
    assert.equal(
      guessEditionFromBody("acho que diar.ia 260506 errou na versão"),
      "260506",
    );
  });

  it("aceita AAMMDD solto como fallback", () => {
    assert.equal(guessEditionFromBody("260504"), "260504");
  });

  it("retorna vazio quando não há AAMMDD plausível", () => {
    assert.equal(guessEditionFromBody("apenas texto sem números"), "");
    assert.equal(guessEditionFromBody(""), "");
    assert.equal(guessEditionFromBody("123456"), ""); // ano 2012 — fora do range
  });

  it("ignora números longos demais (CEP, IDs)", () => {
    // 12345678 não casa porque exige exatamente 6 dígitos com fronteira de palavra
    assert.equal(guessEditionFromBody("CEP 12345678"), "");
  });
});

describe("guessErrorType — heurística por keywords (#929)", () => {
  it("detecta version_inconsistency", () => {
    assert.equal(guessErrorType("vi V4 no título mas V5 no parágrafo"), "version_inconsistency");
    assert.equal(guessErrorType("a versão 3 está errada"), "version_inconsistency");
  });

  it("detecta typo", () => {
    assert.equal(guessErrorType("um typo na frase"), "typo");
    assert.equal(guessErrorType("erro de digitação"), "typo");
  });

  it("detecta math", () => {
    assert.equal(guessErrorType("a conta não bate"), "math");
    assert.equal(guessErrorType("erro matemático no cálculo"), "math");
  });

  it("detecta factual", () => {
    assert.equal(guessErrorType("o nome está errado"), "factual");
  });

  it("detecta outdated", () => {
    assert.equal(guessErrorType("informação desatualizada"), "outdated");
  });

  it("retorna unknown quando nada bate", () => {
    assert.equal(guessErrorType("apenas obrigado"), "unknown");
    assert.equal(guessErrorType(""), "unknown");
  });
});

describe("classifyGabarito — cross-reference contra intentional-errors (#929)", () => {
  const intentional: IntentionalError[] = [
    {
      edition: "260505",
      error_type: "version_inconsistency",
      destaque: 2,
      is_feature: true,
      detail: "V4 no título, V5/V6/V7 nos parágrafos do D2",
    },
    {
      edition: "260507",
      error_type: "factual",
      destaque: 1,
      is_feature: true,
      detail: "iPhone 15 e 16 são as versões corretas",
    },
  ];

  it("hit quando error_type bate", () => {
    const candidate = {
      edition_guessed: "260505",
      error_type_guess: "version_inconsistency",
      body: "blá",
    };
    assert.equal(classifyGabarito(candidate, intentional), "hit");
  });

  it("hit por overlap de palavras do detail no body", () => {
    const candidate = {
      edition_guessed: "260507",
      error_type_guess: "unknown",
      body: "vi iPhone 5 e 6 no texto, mas as versões corretas são 15 e 16",
    };
    assert.equal(classifyGabarito(candidate, intentional), "hit");
  });

  it("miss quando edição identificada mas error_type errado", () => {
    const candidate = {
      edition_guessed: "260505",
      error_type_guess: "math",
      body: "alguma conta errada",
    };
    assert.equal(classifyGabarito(candidate, intentional), "miss");
  });

  it("unclear quando edição não identificada", () => {
    const candidate = {
      edition_guessed: "",
      error_type_guess: "factual",
      body: "qualquer coisa",
    };
    assert.equal(classifyGabarito(candidate, intentional), "unclear");
  });

  it("unclear quando edição sem erro registrado", () => {
    const candidate = {
      edition_guessed: "260101",
      error_type_guess: "factual",
      body: "qualquer coisa",
    };
    assert.equal(classifyGabarito(candidate, intentional), "unclear");
  });
});

describe("recommend — sugestão editorial (#929)", () => {
  it("APPROVE quando hit + error_type identificado", () => {
    const r = recommend("hit", "version_inconsistency", true);
    assert.equal(r.recommendation, "APPROVE");
  });

  it("REJECT quando miss + edição identificada", () => {
    const r = recommend("miss", "factual", true);
    assert.equal(r.recommendation, "REJECT");
  });

  it("REVIEW quando unclear sem edição", () => {
    const r = recommend("unclear", "factual", false);
    assert.equal(r.recommendation, "REVIEW");
  });

  it("REVIEW para casos ambíguos (hit sem error_type)", () => {
    const r = recommend("hit", "unknown", true);
    assert.equal(r.recommendation, "REVIEW");
  });
});

describe("classify — pipeline completo (#929)", () => {
  const intentional: IntentionalError[] = [
    {
      edition: "260505",
      error_type: "version_inconsistency",
      is_feature: true,
      detail: "V4 vs V5/V6/V7",
    },
  ];

  const sample: RawThread = {
    thread_id: "t1",
    sender_email: "leitor@example.com",
    sender_name: "Maria Silva",
    subject: "Re: Diar.ia 260505",
    body: "Encontrei o erro: na edição 260505 vocês colocaram V4 no título mas V5 no parágrafo!",
    received_iso: "2026-05-06T10:00:00Z",
  };

  it("retorna candidate enriquecido pra thread nova", () => {
    const result = classify([sample], new Set(), intentional);
    assert.equal(result.length, 1);
    assert.equal(result[0].edition_guessed, "260505");
    assert.equal(result[0].error_type_guess, "version_inconsistency");
    assert.equal(result[0].gabarito_match, "hit");
    assert.equal(result[0].recommendation, "APPROVE");
  });

  it("filtra threads já processadas (idempotência)", () => {
    const result = classify([sample], new Set(["t1"]), intentional);
    assert.equal(result.length, 0);
  });

  it("body_excerpt é truncado em 240 chars + whitespace normalizado", () => {
    const longBody = "edição 260505 ".repeat(50);
    const result = classify(
      [{ ...sample, body: longBody }],
      new Set(),
      intentional,
    );
    assert.ok(result[0].body_excerpt.length <= 240);
    assert.ok(!result[0].body_excerpt.includes("\n"));
  });

  it("preserva metadados originais (sender, subject, etc)", () => {
    const result = classify([sample], new Set(), intentional);
    assert.equal(result[0].sender_email, "leitor@example.com");
    assert.equal(result[0].sender_name, "Maria Silva");
    assert.equal(result[0].subject, "Re: Diar.ia 260505");
    assert.equal(result[0].thread_id, "t1");
  });

  it("processa múltiplas threads independentemente", () => {
    const t2: RawThread = {
      ...sample,
      thread_id: "t2",
      body: "obrigado pela edição, sem comentários específicos",
    };
    const result = classify([sample, t2], new Set(), intentional);
    assert.equal(result.length, 2);
    assert.equal(result[0].recommendation, "APPROVE");
    assert.equal(result[1].recommendation, "REVIEW"); // sem edição identificável
  });
});
