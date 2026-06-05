/**
 * test/monthly-render-sections.test.ts (#1901/#1902)
 *
 * Regressão: o renderer mensal (scripts/lib/monthly-render.ts) precisa
 * reconhecer e renderizar as seções USE MELHOR DO MÊS e RADAR DO MÊS
 * (que substituíram OUTRAS NOTÍCIAS DO MÊS). Sem isso, o email publicado
 * não renderizava as seções novas como seções (caíam como prosa solta).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isSectionLabel,
  renderLinkListSection,
  renderOutrasNoticias,
  draftToEmail,
} from "../scripts/lib/monthly-render.ts";

describe("isSectionLabel — novos labels Use Melhor / Radar", () => {
  it("reconhece **USE MELHOR DO MÊS**", () => {
    assert.equal(isSectionLabel("**USE MELHOR DO MÊS**"), true);
  });
  it("reconhece **RADAR DO MÊS**", () => {
    assert.equal(isSectionLabel("**RADAR DO MÊS**"), true);
  });
  it("ainda reconhece **OUTRAS NOTÍCIAS DO MÊS** (back-compat)", () => {
    assert.equal(isSectionLabel("**OUTRAS NOTÍCIAS DO MÊS**"), true);
  });

  // #1904-followup: o editor encurta os rótulos pra "USE MELHOR"/"RADAR".
  it("reconhece o rótulo curto **USE MELHOR** (sem DO MÊS)", () => {
    assert.equal(isSectionLabel("**USE MELHOR**"), true);
  });
  it("reconhece o rótulo curto **RADAR** (sem DO MÊS)", () => {
    assert.equal(isSectionLabel("**RADAR**"), true);
  });
  // #1904-followup (code-review #1906): "RADAR"/"USE MELHOR" são palavras comuns;
  // uma linha 100%-bold que apenas COMEÇA com elas NÃO é fronteira de seção.
  it("NÃO trata **RADAR DA OPENAI** / **USE MELHOR SEU TEMPO** como rótulo", () => {
    assert.equal(isSectionLabel("**RADAR DA OPENAI**"), false);
    assert.equal(isSectionLabel("**USE MELHOR SEU TEMPO**"), false);
    assert.equal(isSectionLabel("**RADARES DA SEMANA**"), false);
  });
});

describe("renderLinkListSection", () => {
  const chunk = [
    "**RADAR DO MÊS**",
    "",
    "[Claude chega a PMEs](https://www.anthropic.com/news/claude-for-small-business)",
    "Pacote com conectores prontos.",
    "",
    "[DeepSeek corta 75% do preço da API](https://www.infomoney.com.br/business/x)",
    "Maior corte de uma vez só.",
  ].join("\n");

  it("renderiza o título de exibição + itens (título + descrição)", () => {
    const html = renderLinkListSection(chunk, "Radar do Mês");
    assert.ok(html.includes("Radar do Mês"));
    assert.ok(html.includes("Claude chega a PMEs"));
    assert.ok(html.includes("Pacote com conectores prontos."));
    assert.ok(html.includes("https://www.anthropic.com/news/claude-for-small-business"));
    assert.ok(html.includes("DeepSeek corta 75% do preço da API"));
  });

  it("renderOutrasNoticias é wrapper back-compat com o título legado", () => {
    const html = renderOutrasNoticias(chunk);
    assert.ok(html.includes("Outras Notícias do Mês"));
    assert.ok(html.includes("Claude chega a PMEs"));
  });
});

describe("draftToEmail — render das seções Use Melhor + Radar", () => {
  const draft = [
    "**ASSUNTO**",
    "Diar.ia | Maio 2026 — teste",
    "",
    "**PREVIEW**",
    "Preview de teste.",
    "",
    "**INTRO**",
    "Intro de teste.",
    "",
    "**USE MELHOR DO MÊS**",
    "",
    "[Claude 101](https://anthropic.skilljar.com/claude-101)",
    "Treinamento introdutório.",
    "",
    "**RADAR DO MÊS**",
    "",
    "[DeepSeek corta 75%](https://www.infomoney.com.br/business/x)",
    "Maior corte de uma vez só.",
    "",
    "**ENCERRAMENTO**",
    "Responda este e-mail.",
  ].join("\n");

  const r = draftToEmail(draft, null, "2605");

  it("extrai subject e preview", () => {
    assert.equal(r.subject, "Diar.ia | Maio 2026 — teste");
    assert.equal(r.previewText, "Preview de teste.");
  });
  it("renderiza a seção Use Melhor com seu título e item", () => {
    // #1919: título de exibição é "Use Melhor", SEM "do Mês".
    assert.ok(r.html.includes("Use Melhor"));
    assert.ok(!r.html.includes("Use Melhor do Mês"));
    assert.ok(r.html.includes("Claude 101"));
  });
  it("renderiza a seção Radar com seu título e item", () => {
    assert.ok(r.html.includes("Radar"));
    assert.ok(!r.html.includes("Radar do Mês"));
    assert.ok(r.html.includes("DeepSeek corta 75%"));
  });

  // #1904-followup: mesmo draft com os rótulos CURTOS (editor encurtou) renderiza
  // as duas seções — antes caíam no fallback de prosa (mergiam no bloco anterior).
  const draftShort = draft.replace("**USE MELHOR DO MÊS**", "**USE MELHOR**").replace("**RADAR DO MÊS**", "**RADAR**");
  const rShort = draftToEmail(draftShort, null, "2605");
  it("rótulo curto USE MELHOR/RADAR renderiza as seções (não cai em prosa)", () => {
    assert.ok(rShort.html.includes("Use Melhor"));
    assert.ok(!rShort.html.includes("Use Melhor do Mês"));
    assert.ok(rShort.html.includes("Claude 101"));
    assert.ok(rShort.html.includes("Radar"));
    assert.ok(!rShort.html.includes("Radar do Mês"));
    assert.ok(rShort.html.includes("DeepSeek corta 75%"));
  });
});
