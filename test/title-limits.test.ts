/**
 * test/title-limits.test.ts (#11254)
 *
 * Os dois limites reais do título de destaque que substituíram o teto fixo de
 * 52 chars: card 4x5 (3 linhas a 62px, mesmo critério do gerador do card) e
 * assunto do e-mail (título do D1 ≤70). Caso real: edição 261027, o editor
 * trocou o D1 para 72 chars e o lint de 52 reprovou um título que o card
 * aceitava.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkTitleCardFit,
  checkTitleEmailSubject,
  checkTitleLimits,
  MAX_SUBJECT_LENGTH,
} from "../scripts/lib/lint-checks/title-limits.ts";
import { checkTitleLengths, MAX_TITLE_LENGTH } from "../scripts/lib/lint-checks/title-length.ts";
import { dailyCardTitleFits } from "../scripts/gen-social-card-4x5.ts";

function edition(d1: string, d2 = "Título curto do segundo", d3 = "Título curto do terceiro"): string {
  return [
    "**DESTAQUE 1 | PRODUTO**",
    "",
    `**[${d1}](https://example.com/1)**`,
    "",
    "Corpo do destaque.",
    "",
    "**DESTAQUE 2 | PESQUISA**",
    "",
    `**[${d2}](https://example.com/2)**`,
    "",
    "Corpo do destaque.",
    "",
    "**DESTAQUE 3 | MERCADO**",
    "",
    `**[${d3}](https://example.com/3)**`,
    "",
    "Corpo do destaque.",
  ].join("\n");
}

// 62 grafemas: acima do antigo teto de 52, cabe no card e no assunto.
const TITULO_62 = "Anthropic lança agente que programa sozinho por horas seguidas";
// Uma "palavra" sem espaço que não quebra: nunca cabe numa linha a 62px.
const TITULO_SEM_QUEBRA = "Supercalifragilisticexpialidocious-hiperautomatizacao-generativa";
// 75 grafemas, quebra normal em palavras.
const TITULO_75 = "Governo publica regra que obriga bancos a explicar decisões tomadas por IA";

describe("title-limits (#11254)", () => {
  it("regressão 261027: título > 52 que cabe no card e no assunto passa nos dois checks", () => {
    assert.ok(TITULO_62.length > MAX_TITLE_LENGTH, "fixture precisa estourar o antigo teto de 52");
    assert.equal(dailyCardTitleFits(TITULO_62), true);
    const md = edition(TITULO_62);
    assert.equal(checkTitleLimits(md).ok, true, JSON.stringify(checkTitleLimits(md)));
    // O alvo de escrita de 52 continua medindo (eval do writer), mas não é o limite.
    assert.equal(checkTitleLengths(md).ok, false);
  });

  it("card 4x5: reprova o título que o gerador do card recusaria, em qualquer destaque", () => {
    assert.equal(dailyCardTitleFits(TITULO_SEM_QUEBRA), false);
    const r = checkTitleCardFit(edition("Título ok", TITULO_SEM_QUEBRA));
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].kind, "card-4x5");
    assert.equal(r.errors[0].destaque, 2);
    assert.equal(r.errors[0].max, null);
  });

  it("card 4x5: mesmo veredito que dailyCardTitleFits para cada título", () => {
    for (const t of [TITULO_62, TITULO_75, TITULO_SEM_QUEBRA, "Curto"]) {
      assert.equal(checkTitleCardFit(edition(t)).ok, dailyCardTitleFits(t), t);
    }
  });

  it("assunto: D1 acima de 70 reprova; o mesmo título em D2/D3 não conta", () => {
    assert.ok(TITULO_75.length > MAX_SUBJECT_LENGTH);
    const noD1 = checkTitleEmailSubject(edition(TITULO_75));
    assert.equal(noD1.ok, false);
    assert.equal(noD1.errors[0].kind, "email-subject");
    assert.equal(noD1.errors[0].destaque, 1);
    assert.equal(noD1.errors[0].max, MAX_SUBJECT_LENGTH);
    assert.equal(checkTitleEmailSubject(edition("Título ok", TITULO_75, TITULO_75)).ok, true);
  });

  it("assunto: exatamente 70 passa, 71 reprova (conta grafemas)", () => {
    const t70 = "a".repeat(10) + " " + "b".repeat(59);
    assert.equal(t70.length, 70);
    assert.equal(checkTitleEmailSubject(edition(t70)).ok, true);
    assert.equal(checkTitleEmailSubject(edition(t70 + "c")).ok, false);
    // 🇧🇷 = 1 grafema (4 code units): 69 + bandeira = 70 grafemas, passa.
    assert.equal(checkTitleEmailSubject(edition("a".repeat(69) + "🇧🇷")).ok, true);
  });

  it("checkTitleLimits agrega os dois tipos de erro", () => {
    const r = checkTitleLimits(edition(TITULO_75, TITULO_SEM_QUEBRA));
    const kinds = r.errors.map((e) => e.kind);
    assert.ok(kinds.includes("email-subject"));
    assert.ok(kinds.includes("card-4x5"));
  });

  it("pré-gate: checa as 3 opções de título do D1, não só a primeira", () => {
    const md = [
      "**DESTAQUE 1 | PRODUTO**",
      "",
      "**[Opção curta](https://example.com/1)**",
      "",
      `**[${TITULO_75}](https://example.com/1)**`,
      "",
      "**[Outra curta](https://example.com/1)**",
      "",
      "Corpo do destaque.",
    ].join("\n");
    const r = checkTitleEmailSubject(md);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].title, TITULO_75);
  });
});
