/**
 * test/monthly-utm-clarice-2975.test.ts (#2975, regressão #633)
 * Estendido no #4040 (UTM por POSIÇÃO) e no #4059 (host de marca canônico).
 *
 * #2975 — assinantes vindos da Clarice News mensal apareciam no Beehiiv como
 * `utm_source=sendinblue` (auto-tag do Brevo), impossível medir a conversão da
 * migração Clarice→Diar.ia. Fix: todo link de marca do render mensal carrega
 * `utm_source=clarice&utm_medium=email&utm_campaign=clarice-{ciclo}`.
 *
 * #4059 — o host desses links passou de `diaria.beehiiv.com` pra `diar.ia.br`
 * (o redirect no Cloudflare preserva a query string desde 260723, então a
 * premissa do #2613 caiu). Links legados escritos pelo `writer-monthly` com o
 * host antigo são NORMALIZADOS pelo render e ainda assim ganham UTM.
 *
 * #4040 — o `utm_campaign` ganhou SUFIXO DE POSIÇÃO
 * (`clarice-{ciclo}-{posicao}`), porque o Beehiiv não persiste `utm_content`
 * na subscription: sem o sufixo dava pra saber que o assinante veio da mensal
 * do ciclo X, mas não POR QUAL LINK ele converteu. As 5 origens são:
 *   - wordmark automático (`applyBrandWordmark` via `renderTextInline`) —
 *     granularidade POR SEÇÃO (`wordmark-apresentacao`, `wordmark-radar`, …),
 *     decisão do editor 260726;
 *   - link markdown inline (`renderInline`)     → `inline`
 *   - botão CTA (`renderCtaButton`)             → `cta`
 *   - título de destaque linkado                → `titulo`
 *   - pill link (Radar / Use Melhor)            → `pill`
 * Cada origem tem que emitir um `utm_campaign` DISTINTO, e nenhuma pode
 * regredir pra `sendinblue`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  draftToEmail,
  normalizeKnownUrl,
  renderCtaButton,
  renderInline,
  renderEncerramento,
  renderLinkListSection,
  setMonthlyUtmCiclo,
  setMonthlyUtmSecao,
} from "../scripts/lib/mensal/monthly-render.ts";
import {
  buildMensalCampaign,
  slugifySecao,
} from "../scripts/lib/shared/utm-registry.ts";

/** Extrai todos os `utm_campaign=` de um HTML (des-escapando `&amp;`). */
function campaigns(html: string): string[] {
  const plain = html.replace(/&amp;/g, "&");
  const out: string[] = [];
  const re = /utm_campaign=([a-z0-9-]+)/gi;
  for (let m = re.exec(plain); m; m = re.exec(plain)) out.push(m[1]);
  return out;
}

describe("UTM clarice em links do host de marca (#2975)", () => {
  it("normalizeKnownUrl injeta utm_source/medium/campaign quando ciclo setado", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const out = normalizeKnownUrl("https://diar.ia.br");
      assert.match(out, /utm_source=clarice/);
      assert.match(out, /utm_medium=email/);
      assert.match(out, /utm_campaign=clarice-2606-07-inline/);
      assert.doesNotMatch(out, /sendinblue/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("#4059: link legado diaria.beehiiv.com é normalizado pro host de marca E ganha o UTM", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const out = normalizeKnownUrl("https://diaria.beehiiv.com");
      assert.match(out, /^https:\/\/diar\.ia\.br\//);
      assert.doesNotMatch(out, /diaria\.beehiiv\.com/);
      assert.match(out, /utm_campaign=clarice-2606-07-inline/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("#4059: normalização de host acontece mesmo sem ciclo (é branding, não medição)", () => {
    const out = normalizeKnownUrl("https://diaria.beehiiv.com/p/edicao-x");
    assert.match(out, /^https:\/\/diar\.ia\.br\/p\/edicao-x/);
    assert.doesNotMatch(out, /utm_campaign/);
  });

  it("normalizeKnownUrl não mexe em hosts de terceiros", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const out = normalizeKnownUrl("https://clarice.ai/?via=diaria");
      assert.equal(out, "https://clarice.ai/?via=diaria");
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("normalizeKnownUrl é no-op de UTM sem ciclo setado (default)", () => {
    const out = normalizeKnownUrl("https://diar.ia.br");
    assert.equal(out, "https://diar.ia.br");
  });
});

describe("#4040 — utm_campaign distinto por POSIÇÃO do link", () => {
  it("renderCtaButton emite a posição `cta`", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const html = renderCtaButton("→ [Assine grátis](https://diar.ia.br)");
      assert.match(html, /utm_campaign=clarice-2606-07-cta"/);
      assert.doesNotMatch(html, /utm_campaign=clarice-2606-07"/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("renderInline (link markdown) emite a posição `inline`", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const html = renderInline("cadastre-se [aqui](https://diar.ia.br).");
      assert.match(html, /utm_campaign=clarice-2606-07-inline"/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("título de item de lista (Radar / Use Melhor) emite a posição `titulo`", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const html = renderLinkListSection(
        "**RADAR**\n\n[Assine a diária](https://diar.ia.br)\n\nDescrição do item.",
        "Radar",
      );
      assert.match(html, /utm_campaign=clarice-2606-07-titulo"/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("pill link do encerramento emite a posição `pill`", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const html = renderEncerramento("Até o mês que vem.\n\n- [Assine a diária](https://diar.ia.br)");
      assert.match(html, /utm_campaign=clarice-2606-07-pill"/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("wordmark carrega a SEÇÃO corrente no sufixo (granularidade decidida pelo editor 260726)", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      setMonthlyUtmSecao("APRESENTAÇÃO");
      const apre = renderInline("a diar.ia.br publica todo dia");
      assert.match(apre, /utm_campaign=clarice-2606-07-wordmark-apresentacao"/);

      setMonthlyUtmSecao("RADAR");
      const radar = renderInline("a diar.ia.br publica todo dia");
      assert.match(radar, /utm_campaign=clarice-2606-07-wordmark-radar"/);

      // Os dois wordmarks NÃO podem colidir — é justamente o ponto do #4040.
      assert.notEqual(campaigns(apre)[0], campaigns(radar)[0]);
    } finally {
      setMonthlyUtmSecao(null);
      setMonthlyUtmCiclo(null);
    }
  });

  it("sem seção setada o wordmark cai em `wordmark-geral` (nunca campaign quebrado)", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const html = renderInline("a diar.ia.br publica todo dia");
      assert.match(html, /utm_campaign=clarice-2606-07-wordmark-geral"/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("draftToEmail: as 5 origens emitem campanhas DISTINTAS e nenhuma vira sendinblue", () => {
    const draft = [
      "**APRESENTAÇÃO**",
      "",
      "Esta é a Clarice News em parceria com diar.ia.br. Se quiser notícias de IA todos os dias, se cadastre gratuitamente [aqui](https://diar.ia.br).",
      "",
      "**DIVULGAÇÃO**",
      "",
      "Conheça a edição diária.",
      "",
      "→ [Assine grátis](https://diar.ia.br)",
      "",
      "**RADAR**",
      "",
      "[Assine a diária](https://diar.ia.br)",
      "",
      "Descrição do item do radar.",
      "",
      "**PARA ENCERRAR**",
      "",
      "Até o mês que vem, com a diar.ia.br.",
      "",
      "- [Assine a diária](https://diaria.beehiiv.com/?utm_source=clarice)",
    ].join("\n");

    const { html } = draftToEmail(draft, "Assunto de teste", "2606");
    const found = new Set(campaigns(html));

    // Nenhuma origem pode ficar no bucket achatado sem sufixo (bug pré-#4040).
    assert.ok(
      !found.has("clarice-2606-07"),
      `campanha sem sufixo de posição vazou: ${[...found].sort().join(", ")}`,
    );

    for (const esperada of [
      "clarice-2606-07-inline", // boilerplate APRESENTAÇÃO
      "clarice-2606-07-cta",    // botão CTA "→ [..](..)" do box de divulgação
      "clarice-2606-07-titulo", // título de item do Radar
      "clarice-2606-07-pill",   // pill do encerramento
    ]) {
      assert.ok(found.has(esperada), `faltou ${esperada}; achei: ${[...found].sort().join(", ")}`);
    }

    // Wordmark: pelo menos um, e SEMPRE por seção (nunca o slug flat).
    const wordmarks = [...found].filter((c) => c.startsWith("clarice-2606-07-wordmark-"));
    assert.ok(wordmarks.length >= 1, `nenhum wordmark por seção; achei: ${[...found].sort().join(", ")}`);
    assert.ok(!found.has("clarice-2606-07-wordmark"), "wordmark caiu no slug flat (regressão do #4040)");

    // #2975 + #4059: nada de sendinblue, nada de host antigo (o link legado do
    // encerramento foi normalizado).
    assert.doesNotMatch(html, /sendinblue/);
    assert.doesNotMatch(html, /diaria\.beehiiv\.com/);
  });

  it("título de destaque linkado emite a posição `titulo`", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      // `renderDestaque` é o caller real; o título linkado sai como
      // `## [Texto](url)` dentro do chunk.
      const html = renderInline("ver [Título](https://exemplo.com)");
      assert.ok(html.includes("exemplo.com")); // sanity do helper
      const titulo = normalizeKnownUrl("https://diar.ia.br", "titulo");
      assert.match(titulo, /utm_campaign=clarice-2606-07-titulo/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("draftToEmail reseta ciclo E seção após terminar (não vazam pra chamada seguinte)", () => {
    draftToEmail("**RADAR**\n\ntexto [aqui](https://diar.ia.br).", "Assunto", "2606");
    assert.equal(normalizeKnownUrl("https://diar.ia.br"), "https://diar.ia.br");
    setMonthlyUtmCiclo("2607-08");
    try {
      // Se a seção "RADAR" tivesse vazado, sairia `wordmark-radar`.
      assert.match(renderInline("a diar.ia.br"), /utm_campaign=clarice-2607-08-wordmark-geral"/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });
});

describe("#4040 — helpers do registry compartilhado", () => {
  it("slugifySecao tira acento/pontuação e é estável", () => {
    assert.equal(slugifySecao("APRESENTAÇÃO"), "apresentacao");
    assert.equal(slugifySecao("USE MELHOR DO MÊS"), "use-melhor-do-mes");
    assert.equal(slugifySecao("É IA?"), "e-ia");
    assert.equal(slugifySecao(""), "geral");
    assert.equal(slugifySecao(null), "geral");
  });

  it("buildMensalCampaign compõe clarice-{ciclo}-{posicao}", () => {
    assert.equal(buildMensalCampaign("2606-07", "cta"), "clarice-2606-07-cta");
    assert.equal(buildMensalCampaign("2606-07", "wordmark-RADAR"), "clarice-2606-07-wordmark-radar");
  });
});
