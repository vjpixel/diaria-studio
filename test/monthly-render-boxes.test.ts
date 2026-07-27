/**
 * test/monthly-render-boxes.test.ts
 *
 * Cobre as adições de render do digest mensal desta rodada:
 *  - box DIVULGAÇÃO (afiliado, ex: Alexa+) e box LIVROS (curadoria) via
 *    renderClariceBox com rótulos próprios;
 *  - imagem no topo do box (renderClariceBox imageUrl) — igual ao box de
 *    curadoria da diária;
 *  - botão CTA centralizado à prova de balas (td align=center);
 *  - flag --use-melhor-count (parseUseMelhorCount).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isSectionLabel,
  renderClariceBox,
  renderCtaButton,
  draftToEmail,
} from "../scripts/lib/mensal/monthly-render.ts";
import { parseUseMelhorCount } from "../scripts/monthly-click-sections.ts";

describe("isSectionLabel reconhece DIVULGAÇÃO e LIVROS", () => {
  it("aceita **DIVULGAÇÃO** e **LIVROS** (mas não CLARICE — DIVULGAÇÃO como LIVROS)", () => {
    assert.equal(isSectionLabel("**DIVULGAÇÃO**"), true);
    assert.equal(isSectionLabel("**LIVROS**"), true);
    // A DIVULGAÇÃO da Clarice continua reconhecida pelo seu próprio ramo.
    assert.equal(isSectionLabel("**CLARICE — DIVULGAÇÃO**"), true);
  });
});

describe("renderClariceBox com imagem no topo", () => {
  const chunk = ["**LIVROS**", "Curadoria de livros sobre IA", "Descrição.", "→ [Confira](https://livros.diaria.workers.dev)"].join("\n");

  it("insere <img> no topo quando imageUrl é passado", () => {
    const html = renderClariceBox(chunk, "Livros", "https://poll.x/img/livros.jpg");
    assert.ok(html.includes('<img src="https://poll.x/img/livros.jpg"'), "imagem presente");
    assert.ok(html.includes("border-radius:12px 12px 0 0"), "cantos superiores arredondados (imagem no topo)");
    // imagem antes do título (h3)
    const img = html.indexOf("livros.jpg");
    const title = html.indexOf("Curadoria de livros");
    assert.ok(img > 0 && img < title, "imagem renderiza acima do título");
  });

  it("sem imageUrl → nenhum <img> no box", () => {
    const html = renderClariceBox(chunk, "Livros");
    assert.ok(!html.includes("<img"), "sem imagem quando não passada");
  });
});

describe("renderCtaButton centralizado (à prova de balas)", () => {
  it("envolve o pill num td align=center", () => {
    const html = renderCtaButton("→ [Confira a página de livros](https://livros.diaria.workers.dev)");
    assert.ok(html.includes('<td align="center">'), "td wrapper centralizado (Gmail ignora margin:auto)");
    // #3698: normalizeKnownUrl reescreve o legado *.diaria.workers.dev pro
    // domínio de marca — href normalizado, não mais o literal de entrada.
    assert.ok(html.includes("https://livros.diar.ia.br"), "href normalizado pro domínio de marca");
    assert.ok(!html.includes("→"), "seta não aparece no botão");
  });
});

describe("draftToEmail dispatch dos boxes DIVULGAÇÃO e LIVROS", () => {
  const draft = [
    "**ASSUNTO**",
    "1. Teste",
    "",
    "**DIVULGAÇÃO**",
    "",
    "Amazon lança Alexa+ no Brasil",
    "",
    "Texto do anúncio.",
    "",
    "→ [Conhecer](https://link.amazon/X)",
    "",
    "**LIVROS**",
    "",
    "Curadoria de livros sobre IA",
    "",
    "Descrição da curadoria.",
    "",
    "→ [Confira a página de livros](https://livros.diaria.workers.dev)",
  ].join("\n");

  it("DIVULGAÇÃO → box com kicker 'Divulgação'", () => {
    const { html } = draftToEmail(draft, "Teste", "2606");
    // #3181: o ponto ● agora vive num <span> separado (era &#9679;&nbsp; solto).
    assert.ok(/<span style="color:#00A0A0;">&#9679;<\/span>&nbsp;Divulga/.test(html), "kicker Divulgação");
    assert.ok(html.includes("Amazon lança Alexa+ no Brasil"), "título do box");
  });

  it("LIVROS → box com kicker 'Livros' e imagem quando livrosImageUrl passado", () => {
    const { html } = draftToEmail(
      draft, "Teste", "2606",
      undefined, undefined, undefined, undefined, undefined,
      "https://poll.x/img/04-livros-promo.jpg",
    );
    // #3181: o ponto ● agora vive num <span> separado (era &#9679;&nbsp; solto).
    assert.ok(/<span style="color:#00A0A0;">&#9679;<\/span>&nbsp;Livros/.test(html), "kicker Livros");
    assert.ok(html.includes('<img src="https://poll.x/img/04-livros-promo.jpg"'), "imagem do box de livros");
  });

  it("LIVROS sem imagem passada → box sem <img> nesse bloco", () => {
    const { html } = draftToEmail(draft, "Teste", "2606");
    // Não há imagens de destaque/eia neste draft, então nenhum <img> deve existir.
    assert.ok(!html.includes("<img"), "sem imagem quando livrosImageUrl ausente");
  });
});

describe("box LIVRO (kicker próprio, sem título interno) — #3581 removeu 'do mês' do kicker", () => {
  it("isSectionLabel reconhece o label curto e o longo legado (bold e sem bold)", () => {
    assert.equal(isSectionLabel("**LIVRO**"), true);
    assert.equal(isSectionLabel("LIVRO"), true);
    // Back-compat: edições/drafts em voo ainda podem trazer o label longo.
    assert.equal(isSectionLabel("**LIVRO DO MÊS**"), true);
    assert.equal(isSectionLabel("LIVRO DO MÊS"), true);
  });

  const draft = [
    "**ASSUNTO**",
    "1. Teste",
    "",
    "**LIVRO**",
    "",
    // 260727: o box voltou a ter título interno; a 1ª linha do bloco É o título.
    // Sem ela, o link do livro seria consumido como título (ver renderClariceBox).
    "Recomendação de leitura",
    "",
    "[**2041: Livro Teste**](https://link.amazon/ABC), de Fulano de Tal.",
    "",
    "Fulano de Tal foi presidente do Google na China.",
    "",
    "Ao lado de Beltrano, ele adota uma estrutura pouco comum.",
  ].join("\n");

  // Mesmo conteúdo, mas com o label longo legado — cobre o draft antigo em voo.
  const draftLegacyLabel = draft.replace("**LIVRO**", "**LIVRO DO MÊS**");

  // Formato ANTIGO (pré-260727): bloco sem linha de título, abrindo direto no
  // parágrafo do livro. É a forma de context/snippets/recomendacao-leitura-mensal.md
  // e de todo draft mensal anterior — precisa continuar renderizando certo.
  const draftFormatoAntigo = draft.replace("Recomendação de leitura\n\n", "");

  // 260727 (reverte #3581): kicker volta a ser a CATEGORIA ("Livro do mês") e o
  // box volta a ter título interno, agora vindo da 1ª linha do bloco
  // ("Recomendação de leitura"). Deixaram de ser redundantes porque passaram a
  // dizer coisas diferentes.
  it("kicker 'Livro do mês' (categoria) + título interno da 1ª linha do bloco", () => {
    const { html } = draftToEmail(draft, "Teste", "2606");
    assert.ok(
      /<span style="color:#00A0A0;">&#9679;<\/span>&nbsp;Livro do mês<\/td>/.test(html),
      "kicker deve ser a categoria 'Livro do mês'",
    );
    assert.ok(html.includes("Recomendação de leitura"), "título interno do box");
    assert.ok(
      !/<h3[^>]*>\s*<a href="https:\/\/link\.amazon\/ABC"/.test(html),
      "o link do livro NÃO pode ser consumido como título do box",
    );
  });

  // Regressão do review da PR #4081: sem esta tolerância, um bloco no formato
  // antigo perde o 1º parágrafo (o link do livro vira <h3> serifado) — e o
  // template mensal ainda manda usar exatamente esse formato.
  it("formato antigo (sem linha de título) NÃO transforma o link do livro em título", () => {
    const { html } = draftToEmail(draftFormatoAntigo, "Teste", "2606");
    assert.ok(
      /<span style="color:#00A0A0;">&#9679;<\/span>&nbsp;Livro do mês<\/td>/.test(html),
      "kicker de categoria também no formato antigo",
    );
    assert.ok(
      !/<h3[^>]*>[\s\S]{0,60}2041: Livro Teste/.test(html),
      "o título do livro não pode virar <h3>",
    );
    assert.ok(
      /<a href="https:\/\/link\.amazon\/ABC"[^>]*><strong>2041: Livro Teste<\/strong><\/a>/.test(html),
      "o parágrafo do livro tem de sobreviver como parágrafo, com o link",
    );
    assert.ok(html.includes("Fulano de Tal foi presidente do Google"), "bio do autor preservada");
  });

  it("label legado 'LIVRO DO MÊS' (back-compat) renderiza o mesmo kicker de categoria", () => {
    const { html } = draftToEmail(draftLegacyLabel, "Teste", "2606");
    assert.ok(
      /<span style="color:#00A0A0;">&#9679;<\/span>&nbsp;Livro do mês<\/td>/.test(html),
      "mesmo kicker a partir do label longo",
    );
    assert.ok(html.includes("Recomendação de leitura"), "título interno também no label legado");
  });

  it("título do livro: **dentro** do link vira <strong>, sem ** literal", () => {
    const { html } = draftToEmail(draft, "Teste", "2606");
    assert.doesNotMatch(html, /\*\*/, `asterisco literal vazou: ${html}`);
    assert.match(
      html,
      /<a href="https:\/\/link\.amazon\/ABC"[^>]*><strong>2041: Livro Teste<\/strong><\/a>/,
      "título do livro em <strong> dentro do <a>",
    );
  });

  it("2 parágrafos impessoais renderizados (autor / livro)", () => {
    const { html } = draftToEmail(draft, "Teste", "2606");
    assert.ok(html.includes("Fulano de Tal foi presidente do Google"), "parágrafo do autor");
    assert.ok(html.includes("estrutura pouco comum"), "parágrafo do livro");
  });
});

describe("parseUseMelhorCount", () => {
  it("--use-melhor-count 6", () => {
    assert.equal(parseUseMelhorCount(["--cycle", "2606-07", "--use-melhor-count", "6"]), 6);
  });
  it("--use-melhor-count=6", () => {
    assert.equal(parseUseMelhorCount(["--use-melhor-count=6"]), 6);
  });
  it("ausente → undefined (default vale)", () => {
    assert.equal(parseUseMelhorCount(["--cycle", "2606-07"]), undefined);
  });
  it("inválido (0, negativo, não-número) → undefined", () => {
    assert.equal(parseUseMelhorCount(["--use-melhor-count", "0"]), undefined);
    assert.equal(parseUseMelhorCount(["--use-melhor-count", "-2"]), undefined);
    assert.equal(parseUseMelhorCount(["--use-melhor-count", "abc"]), undefined);
  });
});
