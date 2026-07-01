/**
 * destaque-title-walk.test.ts (#2693 item 1)
 *
 * Testes de regressão para o parser compartilhado `walkDestaqueTitles`,
 * extraído de `countTitlesPerHighlight` (titles-per-highlight.ts) e
 * `extractAllTitles` (title-normalization.ts) — os dois duplicavam o mesmo
 * loop de "walk + break" sincronizado só por comentário.
 *
 * Cobre o contrato central (terminators + `t !== category` guard) para que
 * uma regressão futura nos dois consumidores seja pega aqui direto, sem
 * precisar reproduzir via markdown de newsletter completo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { walkDestaqueTitles } from "../scripts/lib/lint-checks/destaque-title-walk.ts";
import { looksLikeTitleOption } from "../scripts/lib/title-heuristic.ts";

describe("walkDestaqueTitles (#2693 item 1)", () => {
  it("coleta título inline até a URL", () => {
    const lines = [
      "DESTAQUE 1 | INTELIGÊNCIA ARTIFICIAL",
      "",
      "[Modelo de IA da Meta supera GPT-4 em benchmarks](https://example.com/d1)",
      "",
      "https://example.com/d1",
      "",
      "Por que isso importa: contexto relevante.",
    ];
    const { titles, nextIndex } = walkDestaqueTitles(lines, 1, "INTELIGÊNCIA ARTIFICIAL", looksLikeTitleOption);
    assert.deepEqual(titles.map((t) => t.title), [
      "Modelo de IA da Meta supera GPT-4 em benchmarks",
    ]);
    // nextIndex aponta pra linha da URL (terminator) — chamador retoma dali.
    assert.equal(lines[nextIndex].trim(), "https://example.com/d1");
  });

  it("coleta 3 opções de título plain-text (pré-poda editorial)", () => {
    const lines = [
      "DESTAQUE 1 | NEGÓCIOS",
      "",
      "Opção de título A sobre negócios",
      "",
      "Opção de título B sobre negócios",
      "",
      "Opção de título C sobre negócios",
      "",
      "https://example.com/x",
    ];
    const { titles } = walkDestaqueTitles(lines, 1, "NEGÓCIOS", looksLikeTitleOption);
    assert.equal(titles.length, 3);
  });

  it("para na 1ª linha de corpo (não parece título) quando isTitleCandidate rejeita", () => {
    const lines = [
      "DESTAQUE 1 | NEGÓCIOS",
      "Título legado do destaque",
      "Este é um parágrafo de corpo que descreve o artigo em detalhes e termina em ponto.",
      "https://example.com/legacy",
    ];
    const { titles, nextIndex } = walkDestaqueTitles(lines, 1, "NEGÓCIOS", looksLikeTitleOption);
    assert.deepEqual(titles.map((t) => t.title), ["Título legado do destaque"]);
    assert.equal(
      lines[nextIndex].trim(),
      "Este é um parágrafo de corpo que descreve o artigo em detalhes e termina em ponto.",
    );
  });

  it("não quebra a coleta quando uma linha de corpo repete a categoria (guard t !== category)", () => {
    // Linha "NEGÓCIOS" sozinha bateria SECTION_HEADER_LINE_RE, mas como é
    // igual à categoria do próprio destaque, não deve terminar a coleta.
    const lines = [
      "DESTAQUE 1 | NEGÓCIOS",
      "",
      "[Título do destaque em negócios](https://example.com/d1)",
      "",
      "NEGÓCIOS",
      "",
      "https://example.com/d1",
    ];
    const { titles, nextIndex } = walkDestaqueTitles(lines, 1, "NEGÓCIOS", looksLikeTitleOption);
    // A linha "NEGÓCIOS" não vira título (falha looksLikeTitleOption por ser
    // maiúscula/curta demais para heurística de título) nem quebra a coleta —
    // o walk segue até a URL.
    assert.equal(lines[nextIndex].trim(), "https://example.com/d1");
    assert.ok(titles.length >= 1);
  });

  it("quebra em header de seção secundária diferente da categoria (RADAR)", () => {
    const lines = [
      "DESTAQUE 1 | NEGÓCIOS",
      "",
      "[Título do destaque](https://example.com/d1)",
      "",
      "RADAR",
      "",
      "[Outro item](https://example.com/radar)",
    ];
    const { titles, nextIndex } = walkDestaqueTitles(lines, 1, "NEGÓCIOS", looksLikeTitleOption);
    assert.deepEqual(titles.map((t) => t.title), ["Título do destaque"]);
    assert.equal(lines[nextIndex].trim(), "RADAR");
  });

  it("quebra em section break `---`", () => {
    const lines = ["DESTAQUE 1 | NEGÓCIOS", "", "[Título do destaque](https://example.com/d1)", "", "---"];
    const { titles, nextIndex } = walkDestaqueTitles(lines, 1, "NEGÓCIOS", looksLikeTitleOption);
    assert.equal(titles.length, 1);
    assert.equal(lines[nextIndex].trim(), "---");
  });

  it("quebra em 'Por que isso importa:' (legacy URL-no-fim)", () => {
    const lines = [
      "DESTAQUE 1 | NEGÓCIOS",
      "Título legado",
      "Por que isso importa: contexto.",
    ];
    const { titles, nextIndex } = walkDestaqueTitles(lines, 1, "NEGÓCIOS", looksLikeTitleOption);
    assert.deepEqual(titles.map((t) => t.title), ["Título legado"]);
    assert.equal(lines[nextIndex].trim(), "Por que isso importa: contexto.");
  });

  it("quebra no próximo header DESTAQUE (destaque sem URL/body)", () => {
    const lines = ["DESTAQUE 1 | NEGÓCIOS", "Título legado", "DESTAQUE 2 | TECNOLOGIA"];
    const { titles, nextIndex } = walkDestaqueTitles(lines, 1, "NEGÓCIOS", looksLikeTitleOption);
    assert.deepEqual(titles.map((t) => t.title), ["Título legado"]);
    assert.equal(lines[nextIndex].trim(), "DESTAQUE 2 | TECNOLOGIA");
  });

  it("retorna vazio quando o bloco não tem títulos (fim do documento)", () => {
    const lines = ["DESTAQUE 1 | NEGÓCIOS"];
    const { titles, nextIndex } = walkDestaqueTitles(lines, 1, "NEGÓCIOS", looksLikeTitleOption);
    assert.equal(titles.length, 0);
    assert.equal(nextIndex, 1);
  });
});
