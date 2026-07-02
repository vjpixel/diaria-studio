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
} from "../scripts/lib/monthly-render.ts";
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
    assert.ok(html.includes("https://livros.diaria.workers.dev"), "href preservado");
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
    assert.ok(/&#9679;&nbsp;Divulga/.test(html), "kicker Divulgação");
    assert.ok(html.includes("Amazon lança Alexa+ no Brasil"), "título do box");
  });

  it("LIVROS → box com kicker 'Livros' e imagem quando livrosImageUrl passado", () => {
    const { html } = draftToEmail(
      draft, "Teste", "2606",
      undefined, undefined, undefined, undefined, undefined,
      "https://poll.x/img/04-livros-promo.jpg",
    );
    assert.ok(/&#9679;&nbsp;Livros/.test(html), "kicker Livros");
    assert.ok(html.includes('<img src="https://poll.x/img/04-livros-promo.jpg"'), "imagem do box de livros");
  });

  it("LIVROS sem imagem passada → box sem <img> nesse bloco", () => {
    const { html } = draftToEmail(draft, "Teste", "2606");
    // Não há imagens de destaque/eia neste draft, então nenhum <img> deve existir.
    assert.ok(!html.includes("<img"), "sem imagem quando livrosImageUrl ausente");
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
