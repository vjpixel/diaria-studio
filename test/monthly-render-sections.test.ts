/**
 * test/monthly-render-sections.test.ts (#1901/#1902)
 *
 * Regressão: o renderer mensal (scripts/lib/mensal/monthly-render.ts) precisa
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
  renderEncerramento,
  draftToEmail,
} from "../scripts/lib/mensal/monthly-render.ts";

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

  // CTA de seção: parágrafo que CONTÉM link mas não COMEÇA com um, na 1ª ou na
  // última posição. Sem este suporte ele era engolido pelo descBuf e saía
  // concatenado na descrição de um item — o CTA parecia parte do tutorial.
  const CTA =
    "Dicas como essas saem todos os dias na edição diária. Para receber, [cadastre-se gratuitamente](https://diar.ia.br/?utm_source=clarice).";
  const linhas = chunk.split("\n");
  // Posição de produção (#Use Melhor): logo após o rótulo, antes do 1º item.
  const chunkCtaNoTopo = [linhas[0], "", CTA, ...linhas.slice(1)].join("\n");
  const chunkCtaNoFim = [chunk, "", CTA].join("\n");

  it("CTA no topo sai entre o kicker e o 1º item, em parágrafo próprio", () => {
    const html = renderLinkListSection(chunkCtaNoTopo, "Use Melhor do Mês");
    const idxCta = html.indexOf("Dicas como essas");
    const idxItem1 = html.indexOf("Claude chega a PMEs");
    assert.ok(idxCta > -1, "CTA ausente do render");
    assert.ok(idxCta < idxItem1, "CTA tem que vir antes do 1º tutorial");
    assert.ok(
      html.slice(idxCta, idxItem1).includes("</p>"),
      "há fechamento de parágrafo entre o CTA e o 1º item",
    );
    // Não pode ser absorvido como descrição de item nenhum.
    assert.doesNotMatch(html, /Dicas como essas[^<]*Pacote com conectores/);
  });

  it("CTA no fim também é reconhecido (mover a linha não exige mudança de código)", () => {
    const html = renderLinkListSection(chunkCtaNoFim, "Use Melhor do Mês");
    const idxDesc = html.indexOf("Maior corte de uma vez só.");
    const idxCta = html.indexOf("Dicas como essas");
    assert.ok(idxDesc > -1 && idxCta > idxDesc, "CTA vem depois dos itens");
    assert.doesNotMatch(html, /Maior corte de uma vez só\.\s*Dicas como essas/);
  });

  // Achado da review da PR #4189: com o guard antigo (`corpo.length > 1`) uma
  // seção só com o CTA e nenhum item saía SÓ com o kicker — o parágrafo era
  // descartado em silêncio. Fora do caminho de produção, mas descarte silencioso
  // numa função exportada é a mesma classe do #2794.
  it("seção só com o CTA e nenhum item ainda renderiza o CTA", () => {
    const html = renderLinkListSection(`**USE MELHOR**\n\n${CTA}`, "Use Melhor");
    assert.ok(html.includes("Use Melhor"), "kicker ausente");
    assert.ok(html.includes("Dicas como essas"), "CTA sumiu do render");
    assert.match(html, /href="https:\/\/diar\.ia\.br\//, "link do CTA sumiu");
  });

  it("descrição sem link nunca é confundida com CTA de seção", () => {
    const html = renderLinkListSection(chunk, "Radar do Mês");
    assert.ok(html.includes("Maior corte de uma vez só."));
    // 2 itens → 2 títulos ancorados; nenhum parágrafo órfão de CTA.
    assert.equal((html.match(/<a href="https:\/\//g) || []).length, 2);
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

describe("renderEncerramento (#2160 — cobertura de teste)", () => {
  // Conteúdo com pills + último parágrafo (vira box bege)
  const body = [
    "Texto de abertura do encerramento.",
    "",
    "- [Cursos de IA](https://cursos.diar.ia)",
    "- [Livros sobre IA](https://livros.diar.ia)",
    "",
    "Responda este e-mail com sugestões.",
  ].join("\n");

  const html = renderEncerramento(body);

  it("emite o kicker 'Para encerrar'", () => {
    assert.ok(html.includes("Para encerrar"), "kicker 'Para encerrar' ausente");
  });

  it("converte bullets em pills com border-radius:999px e font-size:16px", () => {
    assert.match(html, /border-radius:999px/, "pills sem border-radius:999px");
    assert.match(html, /font-size:16px/, "pills sem font-size:16px");
    assert.ok(html.includes("https://cursos.diar.ia"), "URL do pill 1 ausente");
    assert.ok(html.includes("https://livros.diar.ia"), "URL do pill 2 ausente");
    assert.ok(html.includes("Cursos de IA"), "label do pill 1 ausente");
    assert.ok(html.includes("Livros sobre IA"), "label do pill 2 ausente");
  });

  it("table de pills tem align='center' + margin:0 auto (Outlook fix #2160)", () => {
    // Outlook 2007–2019 ignora align= em <table>; margin:0 auto garante centralização.
    assert.match(
      html,
      /align="center"[^>]*style="margin:0 auto;"/,
      "table de pills sem margin:0 auto — Outlook quebrado",
    );
  });

  it("último parágrafo vira box bege (não cai como prosa solta)", () => {
    // Regressão: último bloco de prosa deve entrar na <table> com background bege,
    // não ser renderizado como <p> solto.
    assert.match(html, /background:[^;]+;border-radius:12px/, "box bege ausente");
    assert.ok(html.includes("Responda este e-mail com sugestões."), "texto do box bege ausente");
  });

  it("prosa intermediária aparece como parágrafo (não cai no box bege)", () => {
    assert.ok(html.includes("Texto de abertura do encerramento."), "prosa de abertura ausente");
  });

  it("sem pills: só kicker + box bege", () => {
    const simple = renderEncerramento("Parágrafo único sem pills.");
    assert.ok(simple.includes("Para encerrar"), "kicker ausente");
    assert.ok(simple.includes("Parágrafo único sem pills."), "prosa ausente");
    assert.doesNotMatch(simple, /border-radius:999px/, "pill não deve aparecer sem bullets");
  });
});
