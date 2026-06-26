/**
 * test/truncated-summary.test.ts (#2596)
 *
 * Testes de regressão para `isTruncatedSummary`.
 *
 * Caso real (issue #2596): Exame — descrição termina em "...conformidade…".
 * A og:description vem cortada na fonte; substantivo + "…" sem pontuação final
 * é o sintoma → DEVE ser sinalizado como truncado (ação (c): warning no Stage 4).
 *
 * Carve-out: reticências intencionais de estilo ("e por aí vai…") e fechamentos
 * com pontuação final NÃO devem disparar.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTruncatedSummary } from "../scripts/lib/truncated-summary.ts";

describe("isTruncatedSummary (#2596)", () => {
  // ------------------------------------------------------------------ //
  //  Caso central da issue + truncamentos involuntários (DEVEM disparar) //
  // ------------------------------------------------------------------ //

  it("CASO DA ISSUE: Exame 'conformidade…' → TRUNCADO", () => {
    assert.equal(
      isTruncatedSummary("A empresa anunciou nova política de conformidade…"),
      true,
    );
  });

  it("substantivo + '...' ASCII sem pontuação → TRUNCADO", () => {
    assert.equal(
      isTruncatedSummary("Relatório aponta crescimento no setor de tecnologia..."),
      true,
    );
  });

  it("preposição 'de' pendente → TRUNCADO", () => {
    assert.equal(isTruncatedSummary("Novas regras de…"), true);
  });

  it("conjunção 'e' pendente → TRUNCADO", () => {
    assert.equal(
      isTruncatedSummary("A empresa promove crescimento, inovação e…"),
      true,
    );
  });

  it("preposição 'para' pendente → TRUNCADO", () => {
    assert.equal(
      isTruncatedSummary("A proposta visa preparar o setor para…"),
      true,
    );
  });

  it("artigo 'o' pendente → TRUNCADO", () => {
    assert.equal(
      isTruncatedSummary("Especialistas recomendam consultar o…"),
      true,
    );
  });

  it("verbo + '...' (frase cortada no meio) → TRUNCADO", () => {
    // og:description cortada após verbo também é truncamento involuntário
    assert.equal(
      isTruncatedSummary("O novo modelo da OpenAI consegue gerar..."),
      true,
    );
  });

  it("ellipsis U+2026 após verbo auxiliar → TRUNCADO", () => {
    assert.equal(
      isTruncatedSummary("Um produto inovador, robusto e seguro que será…"),
      true,
    );
  });

  // ------------------------------------------------------------------ //
  //  Carve-out: reticências INTENCIONAIS (NÃO devem disparar)            //
  // ------------------------------------------------------------------ //

  it('"e por aí vai..." — idioma de suspense → NÃO truncado', () => {
    assert.equal(isTruncatedSummary("O mercado cresceu e por aí vai..."), false);
  });

  it('"e assim por diante…" — idioma de suspense → NÃO truncado', () => {
    assert.equal(
      isTruncatedSummary("Inclui texto, imagem, áudio e assim por diante…"),
      false,
    );
  });

  it('"entre outros…" — idioma de enumeração → NÃO truncado', () => {
    assert.equal(
      isTruncatedSummary("Suporta Python, Go, Rust entre outros…"),
      false,
    );
  });

  it('"etc…" → NÃO truncado', () => {
    assert.equal(
      isTruncatedSummary("Ferramentas como ChatGPT, Claude, Gemini etc…"),
      false,
    );
  });

  it("pontuação final válida antes do ellipsis → NÃO truncado", () => {
    assert.equal(isTruncatedSummary("A frase termina corretamente.…"), false);
  });

  // ------------------------------------------------------------------ //
  //  Casos sem reticências (NÃO disparam)                                //
  // ------------------------------------------------------------------ //

  it("sem reticências → NÃO truncado", () => {
    assert.equal(isTruncatedSummary("Texto terminando com ponto final."), false);
  });

  it("string vazia → NÃO truncado", () => {
    assert.equal(isTruncatedSummary(""), false);
  });

  it("só whitespace → NÃO truncado", () => {
    assert.equal(isTruncatedSummary("    "), false);
  });

  // ------------------------------------------------------------------ //
  //  Edge cases                                                          //
  // ------------------------------------------------------------------ //

  it("apenas reticências (sem texto antes) → NÃO truncado", () => {
    assert.equal(isTruncatedSummary("…"), false);
    assert.equal(isTruncatedSummary("..."), false);
  });

  it("texto truncado com trailing whitespace após ellipsis → TRUNCADO", () => {
    assert.equal(isTruncatedSummary("O projeto visa implementar e…   "), true);
  });

  it("texto sem ellipsis com trailing whitespace → NÃO truncado", () => {
    assert.equal(isTruncatedSummary("O projeto visa implementar e   "), false);
  });
});
