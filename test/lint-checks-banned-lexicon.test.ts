/**
 * test/lint-checks-banned-lexicon.test.ts (#7260)
 *
 * Regressão (#633) do lint `checkBannedLexicon` — reincidência de "agentivo"
 * em vez de "agêntico" em 7 edições (260510, 260515, 260518, 260625, 260731,
 * 260821, 260903). GATE-BLOCKING: sem exceção legítima conhecida.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkBannedLexicon, BANNED_LEXICON } from "../scripts/lib/lint-checks/banned-lexicon.ts";

describe("checkBannedLexicon (#7260)", () => {
  it("CASO REAL 260903: flagra 'agentivos' em texto social", () => {
    const md =
      "A versão Cyber foi desenhada pra apoiar fluxos agentivos — sistemas que tomam decisões em cadeia sem um humano clicando em cada etapa.";
    const result = checkBannedLexicon(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].id, "agentivo-agentico");
    assert.equal(result.errors[0].matched, "agentivos");
    assert.equal(result.errors[0].correct, "agêntico");
    assert.equal(result.errors[0].sourceIssue, "#7260");
    assert.equal(result.errors[0].line, 1);
  });

  it("flagra todas as 4 flexões: agentivo/agentiva/agentivos/agentivas", () => {
    const md = [
      "Um sistema agentivo age sozinho.",
      "Uma arquitetura agentiva reduz fricção.",
      "Vários frameworks agentivos surgiram este ano.",
      "As camadas agentivas coordenam os agentes.",
    ].join("\n");
    const result = checkBannedLexicon(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 4);
    const matched = result.errors.map((e) => e.matched.toLowerCase());
    assert.deepEqual(matched, ["agentivo", "agentiva", "agentivos", "agentivas"]);
  });

  it("case-insensitive: flagra 'Agentivo' com maiúscula inicial", () => {
    const md = "Agentivo é o termo errado aqui.";
    const result = checkBannedLexicon(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].matched, "Agentivo");
  });

  it("NÃO flagra 'agêntico' e suas flexões (forma correta)", () => {
    const md = [
      "Um sistema agêntico age sozinho.",
      "Uma arquitetura agêntica reduz fricção.",
      "Vários frameworks agênticos surgiram este ano.",
      "As camadas agênticas coordenam os agentes.",
      "AGÊNTICO em maiúsculas também não deveria flagrar.",
    ].join("\n");
    const result = checkBannedLexicon(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("NÃO produz falso positivo em palavras que apenas contêm a sequência 'agentiv'", () => {
    // Nenhuma palavra legítima do português conhecida contém "agentiv" como
    // substring de uma palavra maior — este teste documenta o raciocínio do
    // \b (word boundary) e serve de sentinela caso alguém enfraqueça a regex
    // pra um match parcial no futuro.
    const md = "compostoagentivoconcatenado não deveria casar porque não há boundary nas duas pontas.";
    const result = checkBannedLexicon(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("texto sem nenhuma menção a agentivo/agêntico passa limpo", () => {
    const md = "A newsletter de hoje cobre modelos multimodais e regulação de dados.";
    const result = checkBannedLexicon(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("acusa múltiplas ocorrências em linhas diferentes, com número de linha correto", () => {
    const md = ["linha 1 ok", "linha 2 com agentivo aqui", "linha 3 ok", "linha 4 com agentivas de novo"].join(
      "\n",
    );
    const result = checkBannedLexicon(md);
    assert.equal(result.errors.length, 2);
    assert.equal(result.errors[0].line, 2);
    assert.equal(result.errors[1].line, 4);
  });

  it("BANNED_LEXICON é extensível — nova entrada não exige mudar o motor do check", () => {
    // Documenta o desenho pedido pela issue (#7260 "Considerar no mesmo
    // passo"): lista de substituições, não check dedicado a 1 termo.
    assert.ok(Array.isArray(BANNED_LEXICON));
    assert.equal(BANNED_LEXICON.length, 1);
    assert.equal(BANNED_LEXICON[0].id, "agentivo-agentico");
  });
});
