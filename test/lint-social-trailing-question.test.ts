/**
 * lint-social-trailing-question.test.ts (#1762)
 *
 * Posts social não devem encerrar com pergunta (CTA-pergunta). Perguntas
 * retóricas no meio do corpo e perguntas entre aspas são aceitáveis.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  lintTrailingQuestion,
  endsWithTrailingQuestion,
  lastMeaningfulSentence,
} from "../scripts/lint-social-md.ts";

describe("endsWithTrailingQuestion (#1762)", () => {
  it("frase terminando em '?' → true", () => {
    assert.equal(endsWithTrailingQuestion("Como você controla o consumo?"), true);
  });
  it("pergunta entre aspas no fim ('vale a pena?\"') → false (citada)", () => {
    assert.equal(endsWithTrailingQuestion('A pergunta deixa de ser "vale a pena?"'), false);
  });
  it("afirmação → false", () => {
    assert.equal(endsWithTrailingQuestion("O controle de custo vira prioridade."), false);
  });
  it("pergunta seguida de hashtags inline → true (strip hashtags)", () => {
    assert.equal(endsWithTrailingQuestion("Como você faz? #IA #DevTools"), true);
  });
  it("afirmação com hashtags inline → false", () => {
    assert.equal(endsWithTrailingQuestion("Vale revisar o consumo. #IA #DevTools"), false);
  });
  // review #1776: evasões que escapavam
  it("#1776: hashtag colada sem espaço (faz?#IA) → true", () => {
    assert.equal(endsWithTrailingQuestion("Como você faz?#IA"), true);
  });
  it("#1776: emoji após '?' (faz? 🚀) → true", () => {
    assert.equal(endsWithTrailingQuestion("Como você usaria isso? 🚀"), true);
    assert.equal(endsWithTrailingQuestion("Como você faz? 🤔 #IA"), true);
  });
  it("#1776: afirmação com emoji → false", () => {
    assert.equal(endsWithTrailingQuestion("Isso muda o jogo. 🚀"), false);
  });
});

describe("lastMeaningfulSentence (#1762)", () => {
  it("ignora linha final só de hashtags", () => {
    assert.equal(
      lastMeaningfulSentence("Texto principal aqui.\n\n#IA #Agentes #DevTools"),
      "Texto principal aqui.",
    );
  });
  it("ignora linha final só de URL", () => {
    assert.equal(
      lastMeaningfulSentence("Confira a análise completa.\nhttps://diar.ia.br"),
      "Confira a análise completa.",
    );
  });
});

describe("lintTrailingQuestion (#1762)", () => {
  const mdWithTrailingQuestion = `# LinkedIn

## d1

A cobrança por uso muda o jogo pra times de engenharia.

Comente abaixo: seu time usa assistente de código com cobrança por uso? Como você controla o consumo?

#IA #DevTools

### comment_diaria

Comentário aqui.

## d2

A integração nova resolve um problema real de quem fecha o mês.

#Financas

# Facebook

## d1

Texto do face fechando com afirmação clara.

#IA
`;

  it("flag: post LinkedIn d1 encerra com pergunta", () => {
    const r = lintTrailingQuestion(mdWithTrailingQuestion);
    assert.equal(r.ok, false);
    assert.ok(r.matches.some((m) => m.platform === "linkedin" && m.destaque === "d1"));
  });

  it("NÃO flag: d2 e facebook d1 fecham com afirmação", () => {
    const r = lintTrailingQuestion(mdWithTrailingQuestion);
    assert.ok(!r.matches.some((m) => m.destaque === "d2"));
    assert.ok(!r.matches.some((m) => m.platform === "facebook"));
  });

  it("NÃO flag: pergunta retórica entre aspas no meio do corpo", () => {
    const md = `# LinkedIn

## d1

A pergunta deixa de ser "vale a pena?" e passa a ser quando adotar.

A resposta define o roadmap do trimestre.

#IA
`;
    const r = lintTrailingQuestion(md);
    assert.equal(r.ok, true);
  });

  it("NÃO flag: comment do LinkedIn que termina em pergunta não conta (só o post principal)", () => {
    const md = `# LinkedIn

## d1

O post principal fecha com afirmação.

### comment_pixel

Será que isso muda tudo?
`;
    const r = lintTrailingQuestion(md);
    assert.equal(r.ok, true);
  });

  it("md sem seções social → ok (no-op)", () => {
    assert.equal(lintTrailingQuestion("# Outra coisa\n\ntexto").ok, true);
  });

  it("#1776: d1 sem linha em branco antes ainda é checado", () => {
    const md = "# LinkedIn\n## d1\nIsso muda tudo. Como você usa IA no dia a dia?\n";
    assert.equal(lintTrailingQuestion(md).ok, false);
  });

  it("#1776: Facebook — pergunta no corpo antes do CTA fixo é flagada", () => {
    const md = `# Facebook

## d1

Os agentes mudam o trabalho. Você já usa algum no dia a dia?

Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br.

#IA
`;
    const r = lintTrailingQuestion(md);
    assert.equal(r.ok, false);
    assert.ok(r.matches.some((m) => m.platform === "facebook"));
  });

  it("#1776: Facebook — corpo com afirmação antes do CTA → ok", () => {
    const md = `# Facebook

## d1

Os agentes mudam o trabalho e o controle de custo vira prioridade.

Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br.

#IA
`;
    assert.equal(lintTrailingQuestion(md).ok, true);
  });
});
