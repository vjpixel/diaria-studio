import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitParagraphs,
  similarity,
  alignParagraphs,
  annotateReversions,
} from "../scripts/clarice-diff.ts";

describe("splitParagraphs", () => {
  it("split por linha em branco dupla", () => {
    const paras = splitParagraphs("Parágrafo 1.\n\nParágrafo 2.\n\nParágrafo 3.");
    assert.deepEqual(paras, ["Parágrafo 1.", "Parágrafo 2.", "Parágrafo 3."]);
  });

  it("trata múltiplas linhas em branco como separador único", () => {
    const paras = splitParagraphs("A.\n\n\n\nB.");
    assert.deepEqual(paras, ["A.", "B."]);
  });

  it("remove parágrafos vazios e trim", () => {
    const paras = splitParagraphs("\n\nA.\n\n   \n\nB.\n\n");
    assert.deepEqual(paras, ["A.", "B."]);
  });

  it("mantém quebras de linha dentro do parágrafo", () => {
    const paras = splitParagraphs("Linha 1\nLinha 2\n\nSegundo parágrafo");
    assert.equal(paras.length, 2);
    assert.equal(paras[0], "Linha 1\nLinha 2");
  });

  it("texto vazio retorna array vazio", () => {
    assert.deepEqual(splitParagraphs(""), []);
    assert.deepEqual(splitParagraphs("\n\n"), []);
  });
});

describe("similarity", () => {
  it("strings idênticas retornam 1", () => {
    assert.equal(similarity("hello world", "hello world"), 1);
  });

  it("strings completamente diferentes retornam próximo de 0", () => {
    const s = similarity("aaaaa", "bbbbb");
    assert.equal(s, 0);
  });

  it("ambas vazias retorna 1", () => {
    assert.equal(similarity("", ""), 1);
  });

  it("edit menor que metade fica > 0.5", () => {
    const s = similarity("hello world", "hello worlds");
    assert.ok(s > 0.9, `esperado > 0.9, got ${s}`);
  });

  it("textos longos usam sampling heurístico", () => {
    const long = "x".repeat(3000);
    const long2 = "x".repeat(2999) + "y";
    const s = similarity(long, long2);
    assert.ok(s > 0.9, `esperado > 0.9 pra diferença mínima em textos longos, got ${s}`);
  });
});

describe("alignParagraphs", () => {
  it("parágrafos idênticos geram 0 changes", () => {
    const orig = ["A.", "B.", "C."];
    const rev = ["A.", "B.", "C."];
    assert.deepEqual(alignParagraphs(orig, rev), []);
  });

  it("edit simples de um parágrafo", () => {
    const orig = ["Alô mundo.", "B.", "C."];
    const rev = ["Olá, mundo.", "B.", "C."];
    const changes = alignParagraphs(orig, rev);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].before, "Alô mundo.");
    assert.equal(changes[0].after, "Olá, mundo.");
  });

  it("inserção no meio", () => {
    const orig = ["A.", "C."];
    const rev = ["A.", "B novo completamente diferente.", "C."];
    const changes = alignParagraphs(orig, rev);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].before, "");
    assert.equal(changes[0].after, "B novo completamente diferente.");
  });

  it("deleção no meio", () => {
    const orig = ["A.", "B que sera removido totalmente.", "C."];
    const rev = ["A.", "C."];
    const changes = alignParagraphs(orig, rev);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].before, "B que sera removido totalmente.");
    assert.equal(changes[0].after, "");
  });

  it("parágrafos adicionados no final", () => {
    const orig = ["A.", "B."];
    const rev = ["A.", "B.", "C novo.", "D novo."];
    const changes = alignParagraphs(orig, rev);
    assert.equal(changes.length, 2);
    assert.equal(changes[0].before, "");
    assert.equal(changes[0].after, "C novo.");
  });

  it("parágrafos removidos do final", () => {
    const orig = ["A.", "B.", "C.", "D."];
    const rev = ["A.", "B."];
    const changes = alignParagraphs(orig, rev);
    assert.equal(changes.length, 2);
    assert.equal(changes[0].after, "");
    assert.equal(changes[1].after, "");
  });

  it("edit alta similaridade é tratado como edit, não insert+delete", () => {
    const orig = ["OpenAI anunciou o novo modelo GPT-5 com capacidades multimodais."];
    const rev = ["OpenAI anunciou o novo modelo GPT-5 com capacidades multimodais avançadas."];
    const changes = alignParagraphs(orig, rev);
    assert.equal(changes.length, 1);
    assert.ok(changes[0].before && changes[0].after);
  });
});

// #3929: Clarice tem precedência sobre o Humanizador — quando a correção da
// Clarice desfaz uma edição de estilo do Humanizador, isso deve ser visível
// no diff apresentado ao editor no gate (critério de aceitação da issue).
describe("annotateReversions (#3929)", () => {
  it("marca reversão quando a Clarice move o texto de volta pra perto do pré-Humanizador", () => {
    const preHumanizerParas = ["O modelo custa 10 milhões de dólares para treinar."];
    // Humanizador reescreveu (before) — Clarice corrigiu de volta (after),
    // ficando idêntico ao pré-Humanizador.
    const changes = [
      {
        before: "Custam 10 milhões de dólares o treino do modelo.",
        after: "O modelo custa 10 milhões de dólares para treinar.",
        index: 0,
      },
    ];
    const annotated = annotateReversions(changes, preHumanizerParas);
    assert.equal(annotated[0].reversion, true);
  });

  it("NÃO marca reversão quando a correção da Clarice é ortográfica comum, sem relação com o pré-Humanizador", () => {
    const preHumanizerParas = ["O modelo custa 10 milhoes de dolares para treinar, sem acento nenhum aqui."];
    const changes = [
      {
        // Humanizador não tocou o parágrafo (before === pre) — Clarice só
        // corrigiu acentuação. Não há o que "reverter" do Humanizador.
        before: "O modelo custa 10 milhoes de dolares para treinar, sem acento nenhum aqui.",
        after: "O modelo custa 10 milhões de dólares para treinar, sem acento nenhum aqui.",
        index: 0,
      },
    ];
    const annotated = annotateReversions(changes, preHumanizerParas);
    assert.equal(annotated[0].reversion, undefined);
  });

  it("NÃO marca reversão quando a correção da Clarice é uma mudança nova, não relacionada ao pré-Humanizador", () => {
    const preHumanizerParas = ["Texto completamente diferente sobre outro assunto qualquer."];
    const changes = [
      {
        before: "OpenAI lança o novo modelo hoje de manha.",
        after: "OpenAI lança o novo modelo hoje de manhã.",
        index: 0,
      },
    ];
    const annotated = annotateReversions(changes, preHumanizerParas);
    assert.equal(annotated[0].reversion, undefined);
  });

  it("ignora entries de add/remove puro (before ou after vazio)", () => {
    const preHumanizerParas = ["A.", "B."];
    const changes = [
      { before: "", after: "Parágrafo novo adicionado pela Clarice.", index: 0 },
      { before: "Parágrafo removido.", after: "", index: 1 },
    ];
    const annotated = annotateReversions(changes, preHumanizerParas);
    assert.equal(annotated[0].reversion, undefined);
    assert.equal(annotated[1].reversion, undefined);
  });

  it("não marca (best-effort) quando o índice não existe no array pré-Humanizador", () => {
    const preHumanizerParas: string[] = [];
    const changes = [
      { before: "Texto do humanizador.", after: "Texto da clarice.", index: 0 },
    ];
    const annotated = annotateReversions(changes, preHumanizerParas);
    assert.equal(annotated[0].reversion, undefined);
  });
});
